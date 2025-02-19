/** @typedef {import('./index').Logger} Logger */

import path from 'path'

import { dim } from 'colorette'
import debug from 'debug'
import { Listr } from 'listr2'
import normalize from 'normalize-path'

import { chunkFiles } from './chunkFiles.js'
import { execGit } from './execGit.js'
import { generateTasks } from './generateTasks.js'
import { getConfigGroups } from './getConfigGroups.js'
import { getRenderer } from './getRenderer.js'
import { getStagedFiles } from './getStagedFiles.js'
import { GitWorkflow } from './gitWorkflow.js'
import { makeCmdTasks } from './makeCmdTasks.js'
import {
  DEPRECATED_GIT_ADD,
  FAILED_GET_STAGED_FILES,
  NOT_GIT_REPO,
  NO_STAGED_FILES,
  NO_TASKS,
  SKIPPED_GIT_ERROR,
  skippingBackup,
} from './messages.js'
import { resolveGitRepo } from './resolveGitRepo.js'
import {
  applyModificationsSkipped,
  cleanupEnabled,
  cleanupSkipped,
  getInitialState,
  hasPartiallyStagedFiles,
  restoreOriginalStateEnabled,
  restoreOriginalStateSkipped,
  restoreUnstagedChangesSkipped,
} from './state.js'
import { GitRepoError, GetStagedFilesError, GitError } from './symbols.js'

const debugLog = debug('lint-staged:runAll')

const createError = (ctx) => Object.assign(new Error('lint-staged failed'), { ctx })

/**
 * Executes all tasks and either resolves or rejects the promise
 *
 * @param {object} options
 * @param {boolean} [options.allowEmpty] - Allow empty commits when tasks revert all staged changes
 * @param {boolean | number} [options.concurrent] - The number of tasks to run concurrently, or false to run tasks serially
 * @param {Object} [options.configObject] - Explicit config object from the js API
 * @param {string} [options.configPath] - Explicit path to a config file
 * @param {string} [options.cwd] - Current working directory
 * @param {boolean} [options.debug] - Enable debug mode
 * @param {number} [options.maxArgLength] - Maximum argument string length
 * @param {boolean} [options.quiet] - Disable lint-staged’s own console output
 * @param {boolean} [options.relative] - Pass relative filepaths to tasks
 * @param {boolean} [options.shell] - Skip parsing of tasks for better shell support
 * @param {boolean} [options.stash] - Enable the backup stash, and revert in case of errors
 * @param {boolean} [options.verbose] - Show task output even when tasks succeed; by default only failed output is shown
 * @param {Logger} logger
 * @returns {Promise}
 */
export const runAll = async (
  {
    allowEmpty = false,
    concurrent = true,
    configObject,
    configPath,
    cwd,
    debug = false,
    maxArgLength,
    quiet = false,
    relative = false,
    shell = false,
    stash = true,
    verbose = false,
  },
  logger = console
) => {
  debugLog('Running all linter scripts...')

  // Resolve relative CWD option
  const hasExplicitCwd = !!cwd
  cwd = hasExplicitCwd ? path.resolve(cwd) : process.cwd()
  debugLog('Using working directory `%s`', cwd)

  const ctx = getInitialState({ quiet })

  const { gitDir, gitConfigDir } = await resolveGitRepo(cwd)
  if (!gitDir) {
    if (!quiet) ctx.output.push(NOT_GIT_REPO)
    ctx.errors.add(GitRepoError)
    throw createError(ctx)
  }

  // Test whether we have any commits or not.
  // Stashing must be disabled with no initial commit.
  const hasInitialCommit = await execGit(['log', '-1'], { cwd: gitDir })
    .then(() => true)
    .catch(() => false)

  // Lint-staged should create a backup stash only when there's an initial commit
  ctx.shouldBackup = hasInitialCommit && stash
  if (!ctx.shouldBackup) {
    logger.warn(skippingBackup(hasInitialCommit))
  }

  const files = await getStagedFiles({ cwd: gitDir })
  if (!files) {
    if (!quiet) ctx.output.push(FAILED_GET_STAGED_FILES)
    ctx.errors.add(GetStagedFilesError)
    throw createError(ctx, GetStagedFilesError)
  }
  debugLog('Loaded list of staged files in git:\n%O', files)

  // If there are no files avoid executing any lint-staged logic
  if (files.length === 0) {
    if (!quiet) ctx.output.push(NO_STAGED_FILES)
    return ctx
  }

  const configGroups = await getConfigGroups({ configObject, configPath, cwd, files }, logger)

  const hasMultipleConfigs = Object.keys(configGroups).length > 1

  // lint-staged 10 will automatically add modifications to index
  // Warn user when their command includes `git add`
  let hasDeprecatedGitAdd = false

  const listrOptions = {
    ctx,
    exitOnError: false,
    nonTTYRenderer: 'verbose',
    registerSignalListeners: false,
    ...getRenderer({ debug, quiet }),
  }

  const listrTasks = []

  // Set of all staged files that matched a task glob. Values in a set are unique.
  const matchedFiles = new Set()

  for (const [configPath, { config, files }] of Object.entries(configGroups)) {
    const relativeConfig = normalize(path.relative(cwd, configPath))
    const stagedFileChunks = chunkFiles({ baseDir: gitDir, files, maxArgLength, relative })

    // Use actual cwd if it's specified, or there's only a single config file.
    // Otherwise use the directory of the config file for each config group,
    // to make sure tasks are separated from each other.
    const groupCwd = hasMultipleConfigs && !hasExplicitCwd ? path.dirname(configPath) : cwd

    const chunkCount = stagedFileChunks.length
    if (chunkCount > 1) {
      debugLog('Chunked staged files from `%s` into %d part', configPath, chunkCount)
    }

    for (const [index, files] of stagedFileChunks.entries()) {
      const chunkListrTasks = await Promise.all(
        generateTasks({ config, cwd: groupCwd, files, relative }).map((task) =>
          makeCmdTasks({
            commands: task.commands,
            cwd: groupCwd,
            files: task.fileList,
            gitDir,
            renderer: listrOptions.renderer,
            shell,
            verbose,
          }).then((subTasks) => {
            // Add files from task to match set
            task.fileList.forEach((file) => {
              // Make sure relative files are normalized to the
              // group cwd, because other there might be identical
              // relative filenames in the entire set.
              const normalizedFile = path.isAbsolute(file)
                ? file
                : normalize(path.join(groupCwd, file))

              matchedFiles.add(normalizedFile)
            })

            hasDeprecatedGitAdd =
              hasDeprecatedGitAdd || subTasks.some((subTask) => subTask.command === 'git add')

            const fileCount = task.fileList.length

            return {
              title: `${task.pattern}${dim(` — ${fileCount} ${fileCount > 1 ? 'files' : 'file'}`)}`,
              task: async () =>
                new Listr(subTasks, {
                  // In sub-tasks we don't want to run concurrently
                  // and we want to abort on errors
                  ...listrOptions,
                  concurrent: false,
                  exitOnError: true,
                }),
              skip: () => {
                // Skip task when no files matched
                if (fileCount === 0) {
                  return `${task.pattern}${dim(' — no files')}`
                }
                return false
              },
            }
          })
        )
      )

      listrTasks.push({
        title:
          `${relativeConfig}${dim(` — ${files.length} ${files.length > 1 ? 'files' : 'file'}`)}` +
          (chunkCount > 1 ? dim(` (chunk ${index + 1}/${chunkCount})...`) : ''),
        task: () => new Listr(chunkListrTasks, { ...listrOptions, concurrent, exitOnError: true }),
        skip: () => {
          // Skip if the first step (backup) failed
          if (ctx.errors.has(GitError)) return SKIPPED_GIT_ERROR
          // Skip chunk when no every task is skipped (due to no matches)
          if (chunkListrTasks.every((task) => task.skip())) {
            return `${relativeConfig}${dim(' — no tasks to run')}`
          }
          return false
        },
      })
    }
  }

  if (hasDeprecatedGitAdd) {
    logger.warn(DEPRECATED_GIT_ADD)
  }

  // If all of the configured tasks should be skipped
  // avoid executing any lint-staged logic
  if (listrTasks.every((task) => task.skip())) {
    if (!quiet) ctx.output.push(NO_TASKS)
    return ctx
  }

  // Chunk matched files for better Windows compatibility
  const matchedFileChunks = chunkFiles({
    // matched files are relative to `cwd`, not `gitDir`, when `relative` is used
    baseDir: cwd,
    files: Array.from(matchedFiles),
    maxArgLength,
    relative: false,
  })

  const git = new GitWorkflow({ allowEmpty, gitConfigDir, gitDir, matchedFileChunks })

  const runner = new Listr(
    [
      {
        title: 'Preparing lint-staged...',
        task: (ctx) => git.prepare(ctx),
      },
      {
        title: 'Hiding unstaged changes to partially staged files...',
        task: (ctx) => git.hideUnstagedChanges(ctx),
        enabled: hasPartiallyStagedFiles,
      },
      {
        title: `Running tasks for staged files...`,
        task: () => new Listr(listrTasks, { ...listrOptions, concurrent }),
        skip: () => listrTasks.every((task) => task.skip()),
      },
      {
        title: 'Applying modifications from tasks...',
        task: (ctx) => git.applyModifications(ctx),
        skip: applyModificationsSkipped,
      },
      {
        title: 'Restoring unstaged changes to partially staged files...',
        task: (ctx) => git.restoreUnstagedChanges(ctx),
        enabled: hasPartiallyStagedFiles,
        skip: restoreUnstagedChangesSkipped,
      },
      {
        title: 'Reverting to original state because of errors...',
        task: (ctx) => git.restoreOriginalState(ctx),
        enabled: restoreOriginalStateEnabled,
        skip: restoreOriginalStateSkipped,
      },
      {
        title: 'Cleaning up temporary files...',
        task: (ctx) => git.cleanup(ctx),
        enabled: cleanupEnabled,
        skip: cleanupSkipped,
      },
    ],
    listrOptions
  )

  await runner.run()

  if (ctx.errors.size > 0) {
    throw createError(ctx)
  }

  return ctx
}

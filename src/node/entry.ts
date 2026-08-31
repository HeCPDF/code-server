import { logger } from "@coder/logger"
import { optionDescriptions, parse, readConfigFile, setDefaults, shouldOpenInExistingInstance } from "./cli"
import { getVersionString, getVersionJsonString } from "./constants"
import { openInExistingInstance, runCodeServer, runCodeCli, shouldSpawnCliProcess } from "./main"
import { isChild, wrapper } from "./wrapper"

async function entry(): Promise<void> {
  // There's no need to check flags like --help or to spawn in an existing
  // instance for the child process because these would have already happened in
  // the parent and the child wouldn't have been spawned. We also get the
  // arguments from the parent so we don't have to parse twice and to account
  // for environment manipulation (like how PASSWORD gets removed to avoid
  // leaking to child processes).
  if (isChild(wrapper)) {
    const args = await wrapper.handshake()
    wrapper.preventExit()
    const server = await runCodeServer(args)
    wrapper.onDispose(() => server.dispose())
    return
  }

  const cliArgs = parse(process.argv.slice(2))
  const configArgs = await readConfigFile(cliArgs.config)
  const args = await setDefaults(cliArgs, configArgs)

  if (args.help) {
    console.log("code-server", getVersionString())
    console.log("")
    console.log(`Usage: code-server [options] [path]`)
    console.log(`    - Opening a directory: code-server ./path/to/your/project`)
    console.log(`    - Opening a saved workspace: code-server ./path/to/your/project.code-workspace`)
    console.log("")
    console.log("Options")
    optionDescriptions().forEach((description) => {
      console.log("", description)
    })
    return
  }

  if (args.version) {
    if (args.json) {
      console.log(getVersionJsonString())
    } else {
      console.log(getVersionString())
    }
    return
  }

  if (shouldSpawnCliProcess(args)) {
    logger.debug("Found VS Code arguments; spawning VS Code CLI")
    return runCodeCli(args)
  }

  const socketPath = await shouldOpenInExistingInstance(cliArgs, args["session-socket"])
  if (socketPath) {
    logger.debug("Trying to open in existing instance")
    return openInExistingInstance(args, socketPath)
  }

  if (process.env.IPADVSCODE_NO_FORK) {
    // iOS denies fork()/posix_spawn() to third-party processes outright (the
    // same sandbox wall that ios-exthost-no-fork.diff routes the extension
    // host around). wrapper.start() here would call ParentProcess.spawn(),
    // which does cp.fork(entry.js) and then waits up to 10s for an IPC
    // handshake message from that "child" -- on iOS the fork never produces
    // a real child, the handshake always times out ("error timed out" in
    // the logs), and the timeout's rejection propagates back to
    // wrapper.exit(), which calls process.exit(1) and kills the only Node
    // process this app has. Run the server directly in this process
    // instead, mirroring the isChild(wrapper) branch above but without a
    // handshake, since args are already parsed locally. This forfeits
    // code-server's own self-update/relaunch support (SIGUSR1/SIGUSR2, the
    // update-triggered relaunch message), which doesn't apply anyway since
    // there's no update mechanism in a static app bundle.
    wrapper.preventExit()
    const server = await runCodeServer(args)
    wrapper.onDispose(() => server.dispose())
    return
  }

  return wrapper.start(args)
}

entry().catch((error) => {
  logger.error(error.message)
  wrapper.exit(error)
})

// The local workbench uses the existing Dashboard build and a loopback-only API.
const build = await new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--config",
    "dashboard/deno.json",
    "-A",
    "npm:vite@8.0.13",
    "build",
    "--config",
    "dashboard/vite.config.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!build.success) Deno.exit(build.code);
const { startSimpleServer } = await import("../src/apps/simple/server.ts");
await startSimpleServer();

// Offline transport fixture: never runs a shell or connects to a host.
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_SSH_FAIL === "1") {
  process.stderr.write("fixture connection failed");
  process.exitCode = 255;
} else if (input.includes("FIXTURE_SLEEP")) {
  process.stdout.write("started\n");
  setTimeout(() => process.stdout.write("finished\n"), 500);
} else if (input.includes("FIXTURE_HANG")) {
  process.stdout.write("started\n");
  setTimeout(() => process.stdout.write("finished\n"), 15000);
} else if (input.includes("FIXTURE_LARGE")) {
  process.stdout.write("begin-" + "x".repeat(2000) + "-end");
  process.stderr.write("fixture-stderr");
} else if (input.includes("FIXTURE_EXIT")) {
  process.stderr.write("command failed");
  process.exitCode = 7;
} else {
  process.stdout.write(JSON.stringify({ input, argv: process.argv.slice(2) }));
}

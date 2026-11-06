// The door-looks scorer and its offline sim (tests/doorlooks/), held in the gate: preflight runs
// scripts/*.test.mjs with `node --test` and nothing under tests/doorlooks/, so a broken bar there
// would otherwise pass review and never run. The tests themselves live beside the scorer; this file
// only brings them into the gate's run.
import "../tests/doorlooks/doorScore.test.mjs";

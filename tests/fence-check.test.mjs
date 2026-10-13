// The staging machine's fence check, run against stand-ins for docker and ip that play out a
// scenario: what it tries, what it reports, and that anything it can't check makes it say so
// and exit 2, never pass.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../deploy/staging/fence-check.sh", import.meta.url));

// docker, as the scenario has it. Every probe it's asked to run is logged, and answered with the
// scenario's answer for that network and address, or "blocked: no answer".
const DOCKER = `#!/usr/bin/env node
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.env.FENCE_SCENARIO, "utf8"));
const args = process.argv.slice(2);
const out = (text) => { process.stdout.write(text); process.exit(0); };
const fail = () => process.exit(1);
const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "";
const [command, sub] = args;
if (command === "compose" && args.includes("exec")) {
  const answer = s.ipv6[args[args.indexOf("-T") + 1]] ?? "";
  answer === "fail" ? fail() : out(answer);
}
if (command === "compose" && args.includes("ps")) out(s.running.join("\\n") + "\\n");
if (command === "network" && sub === "ls") s.networkLsFails ? fail() : out(["bridge", "obl-staging_outside", "obl-staging_front", "obl-staging_backend", ...Object.keys(s.peers)].join("\\n") + "\\n");
if (command === "network" && sub === "inspect") {
  const name = args[2];
  if (name.startsWith("obl-staging_")) {
    const net = s.stack[name.slice("obl-staging_".length)];
    if (!net) fail();
    if (format.includes(".Id")) out(net.id + "\\n");
    if (format.includes("Gateway")) out(net.gateway + "\\n");
    out("");
  }
  if (name === "bridge") out("");
  if (!s.peers[name]) fail();
  out(s.peers[name].map((c) => c.name + " " + c.ip + "/16\\n").join(""));
}
if (command === "ps") s.psFails ? fail() : out(s.published.map(([name, ports]) => name + " " + ports + "\\n").join(""));
if (command === "inspect") {
  const container = Object.values(s.peers).flat().find((c) => c.name === args.at(-1));
  out((container?.exposed ?? []).map((p) => p + "/tcp ").join(""));
}
if (command === "run") {
  const net = args[args.indexOf("--network") + 1].slice("obl-staging_".length);
  const target = net + " " + args.at(-2) + ":" + args.at(-1);
  fs.appendFileSync(process.env.FENCE_LOG, target + "\\n");
  out((s.answers[target] ?? "blocked: no answer") + "\\n");
}
process.exit(3);
`;

// ip, as the scenario has it: the machine's LAN address, its router, and its bridges' addresses.
const IP = `#!/usr/bin/env node
const s = JSON.parse(require("fs").readFileSync(process.env.FENCE_SCENARIO, "utf8"));
const args = process.argv.slice(2).join(" ");
const out = (text) => { process.stdout.write(text); process.exit(0); };
if (args.includes("route get")) out("1.1.1.1 via " + s.router + " dev eth0 src " + s.lan + " uid 1000\\n");
if (args.includes("route show default")) out("default via " + s.router + " dev eth0 proto dhcp\\n");
const dev = /dev (br-\\S+)/.exec(args)?.[1];
if (dev && s.bridges[dev]) out("9: " + dev + "    inet " + s.bridges[dev] + "/24 brd x scope global " + dev + "\\n");
process.exit(1);
`;

const id = (c) => c.repeat(64);
const STACK = {
  outside: { id: id("a"), gateway: "" },
  front: { id: id("b"), gateway: "" },
  backend: { id: id("c"), gateway: "" },
};
const BRIDGES = { [`br-${id("a").slice(0, 12)}`]: "172.31.242.1", [`br-${id("b").slice(0, 12)}`]: "172.31.241.1", [`br-${id("c").slice(0, 12)}`]: "172.31.240.1" };
const FLAGS = ["--lan", "192.0.2.10", "--router", "192.0.2.1"];

function check(scenario = {}, args = FLAGS) {
  const dir = mkdtempSync(join(tmpdir(), "fence-check-"));
  try {
    for (const [name, body] of [["docker", DOCKER], ["ip", IP]]) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    const full = {
      stack: STACK, bridges: BRIDGES, lan: "192.0.2.10", router: "192.0.2.1", running: ["tor", "relay"],
      ipv6: {}, peers: {}, published: [], answers: {}, ...scenario,
    };
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(full));
    const log = join(dir, "probes.log");
    const run = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FENCE_SCENARIO: join(dir, "scenario.json"), FENCE_LOG: log },
    });
    const probes = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { code: run.status, out: run.stdout, err: run.stderr, probes, posted: run.stdout.split("To post")[1] ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with every try blocked and no IPv6, the fence holds, and the summary names no address", () => {
  const r = check({ published: [["node-app", "0.0.0.0:8080->8080/tcp, :::8080->8080/tcp"]], peers: { app_net: [{ name: "app", ip: "10.21.0.4", exposed: [3000] }] } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /The fence holds\./);
  assert.deepEqual(r.probes, [
    "outside 192.0.2.10:22", "outside 172.31.242.1:22", "outside 192.0.2.1:80", "outside 192.0.2.10:8080",
    "outside 10.21.0.4:3000", "front 192.0.2.10:22", "front 172.31.241.1:22", "backend 192.0.2.10:22", "backend 172.31.240.1:22",
  ]);
  assert.doesNotMatch(r.posted, /192\.0\.2\.|172\.31\.|10\.21\.|8080|3000/);
});

test("a refusal anywhere means something got through", () => {
  const r = check({ answers: { "front 172.31.241.1:22": "REACHABLE: it refused, so something answered" } });
  assert.equal(r.code, 1);
  assert.match(r.out, /Something got through/);
});

test("every port in a published range is tried", () => {
  const r = check({ published: [["node-app", "0.0.0.0:9000-9002->9000-9002/tcp, :::9000-9002->9000-9002/tcp, 0.0.0.0:53->53/udp"]] });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(r.probes.filter((p) => p.startsWith("outside 192.0.2.10:9")), ["outside 192.0.2.10:9000", "outside 192.0.2.10:9001", "outside 192.0.2.10:9002"]);
  assert.ok(!r.probes.includes("outside 192.0.2.10:53"), "UDP isn't tried over TCP");
});

test("anything it can't list or read leaves the fence unchecked, never passed", () => {
  for (const [what, scenario] of [
    ["docker ps fails", { psFails: true }],
    ["docker network ls fails", { networkLsFails: true }],
    ["a range too large to try", { published: [["node-app", "0.0.0.0:1000-2000->1000-2000/tcp"]] }],
    ["a mapping it can't read", { published: [["node-app", "0.0.0.0:http->80/tcp"]] }],
    ["no gateway anywhere", { bridges: {} }],
    ["a service whose IPv6 can't be read", { ipv6: { relay: "fail" } }],
  ]) {
    const r = check(scenario);
    assert.equal(r.code, 2, `${what}: ${r.out}${r.err}`);
    assert.match(r.out, /couldn't check|couldn't run/, what);
    assert.doesNotMatch(r.out, /The fence holds/, what);
    assert.doesNotMatch(r.err, /unexpected error/, `${what}: an expected failure, reported as such`);
  }
});

test("a container that declares no ports is still tried, on any port", () => {
  const r = check({
    peers: { app_net: [{ name: "app", ip: "10.21.0.4" }] },
    answers: { "outside 10.21.0.4:1": "REACHABLE: it refused, so something answered" },
  });
  assert.ok(r.probes.includes("outside 10.21.0.4:1"));
  assert.equal(r.code, 1);
});

test("IPv6 is reported for every service it's found in, beside any it couldn't read", () => {
  const r = check({ running: ["tor", "relay", "lnd"], ipv6: { tor: "fe80000000000000 02 40 20 80 eth0\n", relay: "fail" } });
  assert.equal(r.code, 1);
  assert.match(r.posted, /IPv6 in the stack's containers: FOUND in tor; couldn't check relay/);
});

test("it finds the machine's address and router itself, and takes the router's port", () => {
  const r = check({}, ["--router-port", "443"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.probes.includes("outside 192.0.2.10:22"));
  assert.ok(r.probes.includes("outside 192.0.2.1:443"));
});

test("an option without its value, or an unknown one, stops it with 2, never 1", () => {
  for (const args of [["--lan"], ["--router-port", "eighty"], ["--everything"]]) {
    assert.equal(check({}, args).code, 2, args.join(" "));
  }
});

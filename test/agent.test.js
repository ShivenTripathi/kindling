import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderPlist, plistPath, LAUNCH_AGENT_LABEL } from "../src/agent.js";

describe("agent (launchd)", () => {
  test("plistPath is under ~/Library/LaunchAgents with the label", () => {
    const p = plistPath();
    assert.match(p, /Library\/LaunchAgents\/com\.kindling\.agent\.plist$/);
  });

  test("renderPlist embeds label, args, and interval", () => {
    const xml = renderPlist({
      nodePath: "/usr/local/bin/node",
      script: "/opt/kindling/src/cli.js",
      intervalSec: 21600,
      logPath: "/tmp/kindling/agent.log",
    });
    assert.match(xml, /<string>com\.kindling\.agent<\/string>/);
    assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
    assert.match(xml, /<string>\/opt\/kindling\/src\/cli\.js<\/string>/);
    assert.match(xml, /<string>run<\/string>/);
    assert.match(xml, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
    assert.match(xml, /<string>\/tmp\/kindling\/agent\.log<\/string>/);
  });

  test("renderPlist produces well-formed XML declaration and plist root", () => {
    const xml = renderPlist({
      nodePath: "node",
      script: "x",
      intervalSec: 3600,
      logPath: "l",
    });
    assert.ok(xml.startsWith("<?xml"));
    assert.match(xml, /<plist version="1\.0">/);
    assert.match(xml, /<\/plist>/);
  });

  test("LAUNCH_AGENT_LABEL is stable", () => {
    assert.equal(LAUNCH_AGENT_LABEL, "com.kindling.agent");
  });
});

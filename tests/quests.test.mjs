import assert from "node:assert/strict";
import test from "node:test";

async function loadQuests() {
    try {
        return await import("../plugin/quests.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Desktop quest identity is not implemented");
        throw error;
    }
}

function encode(properties) {
    return Buffer.from(JSON.stringify(properties), "utf8").toString("base64");
}

function decode(value) {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

const superProperties = {
    os: "Windows",
    browser: "Chrome",
    device: "",
    system_locale: "en-US",
    client_version: "1.0.9175",
    browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0",
    browser_version: "157.0.0.0"
};

function heartbeatRequest(overrides = {}) {
    return {
        url: "/quests/1234567890/heartbeat",
        method: "POST",
        headers: { "X-Super-Properties": encode(superProperties) },
        body: { stream_key: "call:1:2", terminal: false },
        ...overrides
    };
}

test("only the quest heartbeat endpoint counts as a quest request", async () => {
    const { isQuestHeartbeatUrl } = await loadQuests();
    assert.equal(isQuestHeartbeatUrl("/quests/123/heartbeat"), true);
    assert.equal(isQuestHeartbeatUrl("/quests/123/heartbeat?x=1"), true);
    assert.equal(isQuestHeartbeatUrl("https://discord.com/api/v9/quests/123/heartbeat"), true);
    assert.equal(isQuestHeartbeatUrl("https://discordapp.com/api/v9/quests/123/heartbeat"), true);

    assert.equal(isQuestHeartbeatUrl("/quests/123/claim-reward"), false);
    assert.equal(isQuestHeartbeatUrl("/quests/123/enroll"), false);
    assert.equal(isQuestHeartbeatUrl("/quests/@me"), false);
    assert.equal(isQuestHeartbeatUrl("/channels/1/messages"), false);
    assert.equal(isQuestHeartbeatUrl("https://discord.com.example.org/api/v9/quests/123/heartbeat"), false);
    assert.equal(isQuestHeartbeatUrl("http://discord.com/api/v9/quests/123/heartbeat"), false);
    assert.equal(isQuestHeartbeatUrl("https://user:pass@discord.com/api/v9/quests/123/heartbeat"), false);
    assert.equal(isQuestHeartbeatUrl("https://1557799582732124221.discordsays.com/quests/123/heartbeat"), false);
    assert.equal(isQuestHeartbeatUrl(undefined), false);
    assert.equal(isQuestHeartbeatUrl(""), false);
});

test("the identity is rewritten for a desktop heartbeat", async () => {
    const { planQuestRequest } = await loadQuests();
    const request = heartbeatRequest();
    const plan = planQuestRequest(request, { enabled: true, clientType: "desktop" });

    assert.ok(plan);
    const properties = decode(plan.headers["X-Super-Properties"]);
    assert.equal(properties.browser, "Discord Client");
    assert.equal(properties.os, "Windows");
    assert.equal(properties.client_version, "1.0.9175");
    assert.equal(properties.system_locale, "en-US");
    // The caller's request is never mutated.
    assert.equal(decode(request.headers["X-Super-Properties"]).browser, "Chrome");
});

test("the header is matched whatever case Discord used", async () => {
    const { planQuestRequest } = await loadQuests();
    const plan = planQuestRequest(heartbeatRequest({ headers: { "x-super-properties": encode(superProperties) } }), {
        enabled: true,
        clientType: "desktop"
    });
    assert.ok(plan);
    assert.equal(decode(plan.headers["x-super-properties"]).browser, "Discord Client");
    assert.equal(Object.keys(plan.headers).filter(key => key.toLowerCase() === "x-super-properties").length, 1);
});

test("the request is left alone unless the switch, the profile and the shape all agree", async () => {
    const { planQuestRequest } = await loadQuests();
    assert.equal(planQuestRequest(heartbeatRequest(), { enabled: false, clientType: "desktop" }), null);
    assert.equal(planQuestRequest(heartbeatRequest(), { enabled: true, clientType: "web" }), null);
    assert.equal(planQuestRequest(heartbeatRequest(), { enabled: true, clientType: "mobile" }), null);
    assert.equal(planQuestRequest(heartbeatRequest({ method: "GET" }), { enabled: true, clientType: "desktop" }), null);
    assert.equal(planQuestRequest(heartbeatRequest({ url: "/quests/123/claim-reward" }), { enabled: true, clientType: "desktop" }), null);
    assert.equal(planQuestRequest({}, { enabled: true, clientType: "desktop" }), null);
});

test("a request without a visible identity header is not rewritten", async () => {
    const { planQuestRequest } = await loadQuests();
    // This is the case the plugin cannot fix: the header is added after this layer, so the
    // request must go out exactly as Discord built it.
    assert.equal(planQuestRequest(heartbeatRequest({ headers: {} }), { enabled: true, clientType: "desktop" }), null);
    assert.equal(planQuestRequest(heartbeatRequest({ headers: undefined }), { enabled: true, clientType: "desktop" }), null);
    assert.equal(planQuestRequest(heartbeatRequest({ headers: { "X-Super-Properties": "" } }), { enabled: true, clientType: "desktop" }), null);
});

test("an identity that cannot be decoded is left untouched", async () => {
    const { planQuestRequest } = await loadQuests();
    const garbage = heartbeatRequest({ headers: { "X-Super-Properties": "not base64 json at all" } });
    assert.equal(planQuestRequest(garbage, { enabled: true, clientType: "desktop" }), null);

    const notAnObject = heartbeatRequest({ headers: { "X-Super-Properties": Buffer.from("[1,2]").toString("base64") } });
    assert.equal(planQuestRequest(notAnObject, { enabled: true, clientType: "desktop" }), null);
});

test("an identity that already says Discord Client is left untouched", async () => {
    const { planQuestRequest } = await loadQuests();
    const already = heartbeatRequest({ headers: { "X-Super-Properties": encode({ ...superProperties, browser: "Discord Client" }) } });
    assert.equal(planQuestRequest(already, { enabled: true, clientType: "desktop" }), null);
});

test("the interceptor is installed once, passes others through and is removed on stop", async () => {
    const { createQuestCompatibility } = await loadQuests();
    const registered = [];
    const store = { clientType: "desktop", desktopQuests: true };
    const sent = [];
    const send = async request => { sent.push(request); return { ok: true, status: 200, body: {} }; };

    const compatibility = createQuestCompatibility({
        store,
        intercept(method, filter, callback) {
            registered.push({ method, filter, callback });
            return () => registered.pop();
        }
    });

    compatibility.start();
    compatibility.start();
    assert.equal(registered.length, 1);
    assert.equal(registered[0].method, "post");

    const { callback, filter } = registered[0];
    assert.equal(filter("/quests/123/heartbeat"), true);
    assert.equal(filter("/channels/1/messages"), false);

    await callback(heartbeatRequest(), send);
    assert.equal(sent.length, 1);
    assert.equal(decode(sent[0].headers["X-Super-Properties"]).browser, "Discord Client");
    assert.deepEqual(sent[0].body, { stream_key: "call:1:2", terminal: false });

    await callback(heartbeatRequest({ headers: {} }), send);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].headers, {});

    const status = compatibility.getStatus();
    assert.equal(status.rewritten, 1);
    assert.equal(status.untouched, 1);

    compatibility.stop();
    assert.equal(registered.length, 0);
    assert.equal(compatibility.getStatus().active, false);
});

test("with the switch off the heartbeat goes out unchanged", async () => {
    const { createQuestCompatibility } = await loadQuests();
    const registered = [];
    const store = { clientType: "desktop", desktopQuests: false };
    const sent = [];
    const compatibility = createQuestCompatibility({
        store,
        intercept(method, filter, callback) {
            registered.push(callback);
            return () => { };
        }
    });
    compatibility.start();

    const request = heartbeatRequest();
    await registered[0](request, async value => { sent.push(value); return {}; });
    assert.equal(sent[0], request);
    assert.equal(decode(sent[0].headers["X-Super-Properties"]).browser, "Chrome");
});

test("an interceptor is required", async () => {
    const { createQuestCompatibility } = await loadQuests();
    assert.throws(() => createQuestCompatibility({ store: {} }), /interceptor/);
});

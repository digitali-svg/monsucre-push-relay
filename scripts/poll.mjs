// Polls LibreLinkUp (GitHub Actions runners aren't blocked by LibreView's
// Cloudflare bot management the way Cloudflare Workers are — see
// cloudflare-worker/README.md for how that was confirmed) and, when it
// finds a reading newer than what the push-relay Worker last saw, calls the
// Worker's /notify endpoint so it can push to the app. No local state here:
// the Worker (via its KV store) is the single source of truth for
// "lastReading", read fresh from it on every run.

const REGION_HOSTS = {
  AE: "api-ae.libreview.io",
  AP: "api-ap.libreview.io",
  AU: "api-au.libreview.io",
  CA: "api-ca.libreview.io",
  DE: "api-de.libreview.io",
  EU: "api-eu.libreview.io",
  EU2: "api-eu2.libreview.io",
  FR: "api-fr.libreview.io",
  JP: "api-jp.libreview.io",
  US: "api-us.libreview.io",
  LA: "api-la.libreview.io",
  RU: "api.libreview.ru",
  CN: "api-cn.myfreestyle.cn",
};

const PRODUCT = "llu.ios";

const EMAIL = requireEnv("LIBRELINKUP_EMAIL");
const PASSWORD = requireEnv("LIBRELINKUP_PASSWORD");
const WORKER_URL = requireEnv("WORKER_URL").replace(/\/$/, "");
const REGISTRATION_SECRET = requireEnv("REGISTRATION_SECRET");
const START_REGION = (process.env.LIBRELINKUP_REGION || "FR").toUpperCase();
const APP_VERSION = process.env.LIBRELINKUP_APP_VERSION || "4.16.0";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function baseHeaders() {
  return {
    "Content-Type": "application/json;charset=UTF-8",
    version: APP_VERSION,
    product: PRODUCT,
  };
}

async function accountIdHash(userId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// LibreLinkUp's `Timestamp` is "M/d/yyyy h:mm:ss a", always UTC with no
// timezone suffix (see LibreTimestampParser.swift in the app's package).
function parseLibreTimestamp(value) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/);
  if (!match) return null;
  const [, month, day, year, hourStr, minute, second, meridiem] = match;
  let hour = parseInt(hourStr, 10) % 12;
  if (meridiem === "PM") hour += 12;
  const ms = Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), hour, parseInt(minute, 10), parseInt(second, 10));
  return Math.floor(ms / 1000);
}

async function login(region, allowRedirect) {
  const response = await fetch(`https://${REGION_HOSTS[region]}/llu/auth/login`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`login HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const decoded = await response.json();
  const data = decoded.data;
  if (decoded.status !== 0 || !data) throw new Error("Invalid LibreLinkUp credentials");

  const stepType = data.step?.type;
  if (stepType) throw new Error(`LibreLinkUp account needs attention in the official app: step "${stepType}"`);

  if (data.redirect === true && data.region) {
    const newRegion = data.region.toUpperCase();
    if (allowRedirect && newRegion !== region && REGION_HOSTS[newRegion]) {
      return login(newRegion, false);
    }
    throw new Error(`Unexpected repeated region redirect to ${newRegion}`);
  }

  if (!data.authTicket || !data.user) throw new Error("Invalid LibreLinkUp credentials");

  return {
    token: data.authTicket.token,
    userId: data.user.id,
    accountIdHash: await accountIdHash(data.user.id),
    region,
  };
}

async function fetchLatestSample(session) {
  const response = await fetch(`https://${REGION_HOSTS[session.region]}/llu/connections`, {
    headers: {
      ...baseHeaders(),
      Authorization: `Bearer ${session.token}`,
      "account-id": session.accountIdHash,
    },
  });
  if (!response.ok) {
    throw new Error(`connections HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const decoded = await response.json();
  const connection = decoded.data?.[0];
  if (!connection) throw new Error("No LibreLinkUp connections found");

  const item = connection.glucoseMeasurement ?? connection.glucoseItem;
  if (!item) return null;

  const timestampEpochSeconds = parseLibreTimestamp(item.Timestamp);
  if (timestampEpochSeconds === null) return null;

  return {
    timestampEpochSeconds,
    valueMgDl: item.ValueInMgPerDl,
    trendRawValue: item.TrendArrow ?? null,
  };
}

async function workerFetch(path, init) {
  const response = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${REGISTRATION_SECRET}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Worker ${path} HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function main() {
  const session = await login(START_REGION, true);
  const sample = await fetchLatestSample(session);
  if (!sample) {
    console.log("No sample on the account yet.");
    return;
  }

  const state = await (await workerFetch("/state")).json();
  if (state.lastReading && state.lastReading.timestampEpochSeconds >= sample.timestampEpochSeconds) {
    console.log(`Unchanged (last seen ${state.lastReading.timestampEpochSeconds}, fetched ${sample.timestampEpochSeconds}).`);
    return;
  }

  if (!state.hasDeviceToken && !state.hasWatchDeviceToken && !state.hasActivityToken) {
    console.log("New reading, but no push targets registered yet — nothing to notify.");
    return;
  }

  const result = await (
    await workerFetch("/notify", { method: "POST", body: JSON.stringify(sample) })
  ).json();
  console.log(`Notified: ${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

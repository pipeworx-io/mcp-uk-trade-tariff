interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * UK Integrated Online Tariff from HMRC's trade-tariff service: look up a UK commodity code, its third-country and preferential duty rates by origin, VAT and excise, import/export licensing conditions, and live tariff-rate quota balances.
 *
 * Keyless JSON:API, the same data that backs the public "Check duties and
 * customs procedures" service on gov.uk, under the Open Government Licence.
 *
 * Tools:
 * - uktariff_search: find a commodity code from a plain-English product description
 * - uktariff_commodity: full duty/VAT/measure detail for one 10-digit commodity code
 * - uktariff_heading: the commodities sitting under one 4-digit heading
 * - uktariff_quota: tariff-rate quotas — volume, balance, status, origin
 *
 * QUIRKS (all verified live 2026-09-17):
 * - The API host is `www.trade-tariff.service.gov.uk`, NOT the
 *   `api.trade-tariff.service.gov.uk` the docs point at. The api. host 301s
 *   every /api/v2 path to the documentation site with an empty body, which
 *   reads as a successful call returning nothing.
 * - Responses are JSON:API: the interesting content lives in `included`, keyed
 *   by (type, id), and `data.relationships` points into it. A commodity call
 *   returns ~450 included objects; this pack resolves measures against them
 *   rather than handing back the raw graph.
 * - /search is polymorphic. A numeric query returns
 *   `{type: "exact_match", entry: {endpoint, id}}` with no results array; a
 *   text query returns `{type: "fuzzy_match", goods_nomenclature_match: {...}}`
 *   with chapters/headings/commodities. Both are 200s.
 * - /quotas/search rejects a `status` filter with a 400 even though status is a
 *   field on every row. Filter on year / order_number / geographical_area_id /
 *   goods_nomenclature_item_id and read status off the result.
 * - Only `declarable: true` commodities can be used on a customs declaration;
 *   search happily returns non-declarable parent lines, so this pack flags it.
 */


const BASE_URL = 'https://www.trade-tariff.service.gov.uk/api/v2';
const UA = 'pipeworx-mcp-uk-trade-tariff/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 'UK Trade Tariff');
}

async function getJson(path: string, params?: Record<string, string>): Promise<any> {
  const u = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== '') u.searchParams.set(k, v);
  const res = await pwFetch(u.toString());
  if (res.status === 404) {
    throw new Error(`UK Trade Tariff has no record at ${u.pathname} — check the code is a current, valid commodity/heading id.`);
  }
  if (!res.ok) {
    throw new Error(`UK Trade Tariff returned HTTP ${res.status} for ${u.pathname}${u.search}`);
  }
  return res.json();
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function digitsOnly(v: unknown): string {
  return str(v).replace(/[^0-9]/g, '');
}

type Ref = { id?: string; type?: string } | null | undefined;

/** Index a JSON:API `included` array by "type:id" so relationships can be resolved. */
function indexIncluded(included: unknown): Map<string, any> {
  const map = new Map<string, any>();
  if (Array.isArray(included)) {
    for (const item of included) {
      if (item && typeof item === 'object' && 'type' in item && 'id' in item) {
        map.set(`${(item as any).type}:${(item as any).id}`, item);
      }
    }
  }
  return map;
}

function resolve(map: Map<string, any>, ref: Ref): any | null {
  if (!ref || !ref.type || ref.id === undefined) return null;
  return map.get(`${ref.type}:${ref.id}`) ?? null;
}

/** Turn a raw JSON:API measure into the fields an importer actually reads. */
function shapeMeasure(measure: any, map: Map<string, any>): Record<string, unknown> {
  const rel = measure?.relationships ?? {};
  const attrs = measure?.attributes ?? {};
  const duty = resolve(map, rel.duty_expression?.data);
  const type = resolve(map, rel.measure_type?.data);
  const geo = resolve(map, rel.geographical_area?.data);
  const legalActs: string[] = Array.isArray(rel.legal_acts?.data)
    ? rel.legal_acts.data.map((a: Ref) => str(a?.id)).filter(Boolean)
    : [];
  const excluded: string[] = Array.isArray(rel.excluded_countries?.data)
    ? rel.excluded_countries.data
        .map((c: Ref) => str(resolve(map, c)?.attributes?.description) || str(c?.id))
        .filter(Boolean)
    : [];

  return {
    measure_id: attrs.id ?? measure?.id,
    measure_type: str(type?.attributes?.description),
    measure_type_series: str(type?.attributes?.measure_type_series_description),
    duty: str(duty?.attributes?.verbose_duty) || str(duty?.attributes?.base),
    origin: str(geo?.attributes?.description),
    origin_code: str(geo?.attributes?.geographical_area_id) || str(geo?.id),
    excluded_countries: excluded,
    direction: attrs.import === true ? 'import' : attrs.export === true ? 'export' : 'unknown',
    is_vat: attrs.vat === true,
    is_excise: attrs.excise === true,
    effective_start_date: str(attrs.effective_start_date),
    effective_end_date: str(attrs.effective_end_date),
    legal_acts: legalActs,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'uktariff_search',
    description:
      'Find the UK commodity code for a product described in plain English, or resolve a numeric code to the right endpoint. Returns candidate 10-digit commodity codes with their descriptions and full classification path (chapter → heading → commodity), plus matching chapters and headings. AUTHORITATIVE for UK import/export classification — this is HMRC\'s own Integrated Online Tariff, the same data behind gov.uk\'s "Check duties and customs procedures for exporting goods". PREFER OVER WEB SEARCH for "what commodity code is X", "HS code for X in the UK". Example: uktariff_search({ query: "roasted coffee beans" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Plain-English product description ("roasted coffee beans", "lithium-ion batteries") or a numeric commodity/heading code',
        },
        limit: { type: 'number', description: 'Maximum commodity matches to return (default 20, max 100)' },
        declarable_only: {
          type: 'boolean',
          description: 'Only return codes that can actually be used on a customs declaration (default true)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'uktariff_commodity',
    description:
      'Full UK tariff detail for one 10-digit commodity code: the third-country (MFN) duty rate, every preferential rate by country or trading bloc, VAT and excise measures, quota-linked rates, and the import/export licensing and document conditions attached to the code. AUTHORITATIVE, sourced from HMRC\'s UK Integrated Online Tariff. Use for "what duty do I pay importing X into the UK", "is there a preferential rate from country Y", "what VAT applies". Example: uktariff_commodity({ code: "0901210000" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: '10-digit UK commodity code, with or without spaces, e.g. "0901210000"' },
        origin: {
          type: 'string',
          description: 'Optional 2-letter country code or area id to filter measures to one origin, e.g. "NZ", "US", "1011" (erga omnes)',
        },
        max_measures: { type: 'number', description: 'Maximum measures to return (default 60, max 200)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'uktariff_heading',
    description:
      'List the commodity codes that sit under one 4-digit UK tariff heading, with descriptions, indent level and whether each is declarable. Use this to drill down after uktariff_search returns a heading, or to enumerate the options within a product family before picking a code. Sourced from HMRC\'s UK Integrated Online Tariff. Example: uktariff_heading({ heading: "0901" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        heading: { type: 'string', description: '4-digit tariff heading, e.g. "0901" (coffee) or "8703" (motor cars)' },
        limit: { type: 'number', description: 'Maximum commodities to return (default 50, max 200)' },
      },
      required: ['heading'],
    },
  },
  {
    name: 'uktariff_quota',
    description:
      'Search UK tariff-rate quotas (TRQs) — the limited volumes of a good that may be imported at a reduced or zero duty rate. Returns each quota definition with its order number, initial volume, REMAINING BALANCE, measurement unit, validity window, status (Open/Exhausted/Blocked) and the origins it applies to. AUTHORITATIVE for "is the UK quota for X still open", "how much of the New Zealand lamb quota is left". Sourced from HMRC\'s UK Integrated Online Tariff. Example: uktariff_quota({ year: 2026, geographical_area_id: "NZ" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        order_number: { type: 'string', description: 'Quota order number, e.g. "050006"' },
        goods_nomenclature_item_id: {
          type: 'string',
          description: '10-digit commodity code the quota applies to, e.g. "0201300000"',
        },
        geographical_area_id: { type: 'string', description: 'Origin country or area code, e.g. "NZ", "AU"' },
        year: { type: 'number', description: 'Quota year, e.g. 2026. Strongly recommended — without a filter the search is the whole register' },
        critical: { type: 'boolean', description: 'Only quotas flagged critical (nearly exhausted, stricter licensing)' },
        limit: { type: 'number', description: 'Maximum quota definitions to return (default 25, max 100)' },
      },
    },
  },
];

async function search(args: Record<string, unknown>): Promise<unknown> {
  const query = str(args.query);
  if (!query) throw new Error('uktariff_search needs a `query` — a product description or a numeric code.');
  const limit = Math.min(Math.max(num(args.limit, 20), 1), 100);
  const declarableOnly = args.declarable_only !== false;

  // The upstream fuzzy search ANDs every term, so one word the nomenclature
  // does not use ("beans") turns a good query into a clean zero — a 200 with
  // three empty arrays, which reads as "the UK does not tariff coffee". Drop
  // trailing words until something matches, and say which query answered.
  let queryUsed = query;
  let data = await getJson('/search', { q: queryUsed });
  let attrs = data?.data?.attributes ?? {};
  const isEmpty = (a: any) => {
    if (str(a?.type) === 'exact_match') return false;
    const gm = a?.goods_nomenclature_match ?? {};
    return (
      (Array.isArray(gm.commodities) ? gm.commodities.length : 0) === 0 &&
      (Array.isArray(gm.headings) ? gm.headings.length : 0) === 0 &&
      (Array.isArray(gm.chapters) ? gm.chapters.length : 0) === 0
    );
  };
  const words = queryUsed.split(/\s+/).filter(Boolean);
  for (let drop = 1; drop < words.length && isEmpty(attrs); drop++) {
    queryUsed = words.slice(0, words.length - drop).join(' ');
    data = await getJson('/search', { q: queryUsed });
    attrs = data?.data?.attributes ?? {};
  }
  const narrowed = queryUsed !== query;

  if (str(attrs.type) === 'exact_match') {
    const entry = attrs.entry ?? {};
    return {
      source: 'HMRC UK Integrated Online Tariff (trade-tariff.service.gov.uk)',
      licence: 'Open Government Licence v3.0',
      query,
      query_used: queryUsed,
      match_type: 'exact_match',
      exact_match: {
        endpoint: str(entry.endpoint),
        id: str(entry.id),
        next_tool:
          str(entry.endpoint) === 'commodities'
            ? `uktariff_commodity({ code: "${str(entry.id)}" })`
            : str(entry.endpoint) === 'headings'
              ? `uktariff_heading({ heading: "${str(entry.id)}" })`
              : null,
      },
      commodities: [],
      headings: [],
      chapters: [],
    };
  }

  const gm = attrs.goods_nomenclature_match ?? {};
  const hits = (arr: unknown): any[] => (Array.isArray(arr) ? arr : []);

  let commodities = hits(gm.commodities).map((h) => {
    const s = h?._source ?? {};
    return {
      commodity_code: str(s.goods_nomenclature_item_id),
      description: str(s.description),
      classification_path: Array.isArray(s.ancestor_descriptions) ? s.ancestor_descriptions : [],
      declarable: s.declarable === true,
      number_indents: num(s.number_indents, 0),
      validity_start_date: str(s.validity_start_date),
      score: num(h?._score, 0),
    };
  });
  if (declarableOnly) commodities = commodities.filter((c) => c.declarable);
  commodities = commodities.slice(0, limit);

  const headings = hits(gm.headings)
    .map((h) => ({
      heading: str(h?._source?.goods_nomenclature_item_id).slice(0, 4),
      description: str(h?._source?.description),
      score: num(h?._score, 0),
    }))
    .slice(0, limit);

  const chapters = hits(gm.chapters)
    .map((h) => ({
      chapter: str(h?._source?.goods_nomenclature_item_id).slice(0, 2),
      description: str(h?._source?.description),
      score: num(h?._score, 0),
    }))
    .slice(0, limit);

  return {
    source: 'HMRC UK Integrated Online Tariff (trade-tariff.service.gov.uk)',
    licence: 'Open Government Licence v3.0',
    query,
    query_used: queryUsed,
    narrowed_to_match: narrowed,
    match_type: str(attrs.type) || 'fuzzy_match',
    declarable_only: declarableOnly,
    commodity_matches: commodities.length,
    commodities,
    headings,
    chapters,
    note: narrowed
      ? `The tariff search requires every word to appear in the nomenclature, and "${query}" matched nothing. These results are for "${queryUsed}".`
      : 'Only `declarable` codes may be used on a customs declaration. Pass a commodity_code to uktariff_commodity for the duty rates.',
  };
}

async function commodity(args: Record<string, unknown>): Promise<unknown> {
  const code = digitsOnly(args.code);
  if (code.length !== 10) {
    throw new Error(`uktariff_commodity needs a 10-digit commodity code; got "${str(args.code)}". Use uktariff_search to find one.`);
  }
  const maxMeasures = Math.min(Math.max(num(args.max_measures, 60), 1), 200);
  const originFilter = str(args.origin).toUpperCase();

  const data = await getJson(`/commodities/${code}`);
  const attrs = data?.data?.attributes ?? {};
  const rel = data?.data?.relationships ?? {};
  const map = indexIncluded(data?.included);

  const measureRefs: Ref[] = Array.isArray(rel.import_measures?.data)
    ? [...rel.import_measures.data, ...(Array.isArray(rel.export_measures?.data) ? rel.export_measures.data : [])]
    : Array.from(map.values())
        .filter((x) => x?.type === 'measure')
        .map((x) => ({ type: 'measure', id: String(x.id) }));

  let measures = measureRefs
    .map((r) => resolve(map, r))
    .filter(Boolean)
    .map((m) => shapeMeasure(m, map));

  if (originFilter) {
    measures = measures.filter(
      (m) => String(m.origin_code).toUpperCase() === originFilter || String(m.origin).toUpperCase() === originFilter,
    );
  }
  const totalMeasures = measures.length;
  measures = measures.slice(0, maxMeasures);

  const summaryObj = Array.from(map.values()).find((x) => x?.type === 'import_trade_summary');
  const headingObj = Array.from(map.values()).find((x) => x?.type === 'heading');
  const chapterObj = Array.from(map.values()).find((x) => x?.type === 'chapter');
  const sectionObj = Array.from(map.values()).find((x) => x?.type === 'section');
  const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').trim();

  return {
    source: 'HMRC UK Integrated Online Tariff (trade-tariff.service.gov.uk)',
    licence: 'Open Government Licence v3.0',
    commodity_code: str(attrs.goods_nomenclature_item_id) || code,
    description: str(attrs.description_plain) || str(attrs.description),
    declarable: attrs.declarable === true,
    basic_duty_rate: stripTags(str(attrs.basic_duty_rate)),
    validity_start_date: str(attrs.validity_start_date),
    validity_end_date: str(attrs.validity_end_date),
    binding_tariff_info_url: str(attrs.bti_url),
    classification: {
      section: sectionObj ? `${str(sectionObj.attributes?.numeral)} — ${str(sectionObj.attributes?.title)}` : null,
      chapter: chapterObj ? str(chapterObj.attributes?.formatted_description) || str(chapterObj.attributes?.description) : null,
      heading: headingObj ? str(headingObj.attributes?.description_plain) || str(headingObj.attributes?.description) : null,
    },
    duty_summary: summaryObj
      ? {
          third_country_duty: stripTags(str(summaryObj.attributes?.basic_third_country_duty)),
          preferential_tariff_duty: stripTags(str(summaryObj.attributes?.preferential_tariff_duty)),
          preferential_quota_duty: stripTags(str(summaryObj.attributes?.preferential_quota_duty)),
        }
      : null,
    origin_filter: originFilter || null,
    measures_total: totalMeasures,
    measures_returned: measures.length,
    measures,
    tariff_url: `https://www.trade-tariff.service.gov.uk/commodities/${code}`,
  };
}

async function heading(args: Record<string, unknown>): Promise<unknown> {
  const h = digitsOnly(args.heading).slice(0, 4);
  if (h.length !== 4) {
    throw new Error(`uktariff_heading needs a 4-digit heading, e.g. "0901"; got "${str(args.heading)}".`);
  }
  const limit = Math.min(Math.max(num(args.limit, 50), 1), 200);

  const data = await getJson(`/headings/${h}`);
  const attrs = data?.data?.attributes ?? {};
  const map = indexIncluded(data?.included);

  const commodities = Array.from(map.values())
    .filter((x) => x?.type === 'commodity' || x?.type === 'subheading')
    .map((x) => ({
      commodity_code: str(x.attributes?.goods_nomenclature_item_id),
      // Two rows can share a code and differ only by this suffix: "10" is the
      // intermediate subheading line, "80" the declarable leaf. Without it the
      // list looks like duplicates with contradictory descriptions.
      producline_suffix: str(x.attributes?.producline_suffix),
      description: str(x.attributes?.description_plain) || str(x.attributes?.description),
      number_indents: num(x.attributes?.number_indents, 0),
      declarable: x.attributes?.declarable === true,
      kind: x.type === 'commodity' ? 'commodity' : 'subheading',
    }))
    .sort((a, b) =>
      a.commodity_code === b.commodity_code
        ? a.producline_suffix.localeCompare(b.producline_suffix)
        : a.commodity_code.localeCompare(b.commodity_code),
    )
    .slice(0, limit);

  return {
    source: 'HMRC UK Integrated Online Tariff (trade-tariff.service.gov.uk)',
    licence: 'Open Government Licence v3.0',
    heading: h,
    description: str(attrs.description_plain) || str(attrs.description),
    validity_start_date: str(attrs.validity_start_date),
    commodities_returned: commodities.length,
    commodities,
    note: 'Only `declarable: true` rows may be used on a customs declaration; the rest are parent lines in the classification tree. A code appearing twice is one subheading line (producline_suffix "10") and one leaf ("80"), not a duplicate.',
  };
}

async function quota(args: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(num(args.limit, 25), 1), 100);
  const params: Record<string, string> = {};
  const orderNumber = str(args.order_number);
  const goods = digitsOnly(args.goods_nomenclature_item_id);
  const geo = str(args.geographical_area_id).toUpperCase();
  if (orderNumber) params.order_number = orderNumber;
  if (goods) params.goods_nomenclature_item_id = goods;
  if (geo) params.geographical_area_id = geo;
  if (args.year !== undefined) params.year = String(Math.trunc(num(args.year, 0)));
  if (args.critical === true) params.critical = 'true';
  params.per_page = String(limit);

  if (Object.keys(params).length === 1) {
    throw new Error(
      'uktariff_quota needs at least one filter — year, order_number, goods_nomenclature_item_id or geographical_area_id. The unfiltered quota register is thousands of definitions.',
    );
  }

  const data = await getJson('/quotas/search', params);
  const map = indexIncluded(data?.included);
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];

  const quotas = rows.slice(0, limit).map((d) => {
    const a = d?.attributes ?? {};
    const rel = d?.relationships ?? {};
    const origins: string[] = Array.isArray(rel.quota_order_number_origins?.data)
      ? rel.quota_order_number_origins.data
          .map((o: Ref) => {
            const obj = resolve(map, o);
            const geoObj = resolve(map, obj?.relationships?.geographical_area?.data);
            return str(geoObj?.attributes?.description) || str(obj?.attributes?.geographical_area_id);
          })
          .filter(Boolean)
      : [];
    const initial = num(a.initial_volume, NaN);
    const balance = num(a.balance, NaN);
    return {
      quota_definition_sid: a.quota_definition_sid,
      order_number: str(a.quota_order_number_id),
      description: str(a.description),
      status: str(a.status),
      initial_volume: Number.isFinite(initial) ? initial : null,
      balance: Number.isFinite(balance) ? balance : null,
      percent_remaining: Number.isFinite(initial) && Number.isFinite(balance) && initial > 0 ? Math.round((balance / initial) * 1000) / 10 : null,
      measurement_unit: str(a.measurement_unit) || str(a.monetary_unit),
      validity_start_date: str(a.validity_start_date),
      validity_end_date: str(a.validity_end_date),
      last_allocation_date: str(a.last_allocation_date),
      origins,
    };
  });

  return {
    source: 'HMRC UK Integrated Online Tariff (trade-tariff.service.gov.uk)',
    licence: 'Open Government Licence v3.0',
    filters: {
      order_number: orderNumber || null,
      goods_nomenclature_item_id: goods || null,
      geographical_area_id: geo || null,
      year: args.year ?? null,
      critical: args.critical === true ? true : null,
    },
    matching_count: num(data?.meta?.pagination?.total_count, quotas.length),
    returned: quotas.length,
    quotas,
    note: 'A `status` filter is rejected upstream with a 400; read status off each row instead. Balance is in the row\'s measurement_unit.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'uktariff_search':
      return search(args);
    case 'uktariff_commodity':
      return commodity(args);
    case 'uktariff_heading':
      return heading(args);
    case 'uktariff_quota':
      return quota(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;

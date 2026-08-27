import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  CONSOLE_HOST,
  consoleBanner,
  interventionPath,
  OperatorConsole,
} from './console-security.js';
import type { Intervention } from '../types/intervention.js';

/**
 * ================================================================================================
 * THE OPERATOR CONSOLE. MINIMAL BY DESIGN, AND THE OMISSIONS ARE THE DESIGN.
 * ================================================================================================
 *
 * Four routes, plain HTML, no framework, no build step. The MECHANISM being evaluated is the lease
 * transfer, the same-live-session guarantee and the reconciliation on resume; the UI is how a person
 * triggers it. Making the UI elaborate would add surface area to the most dangerous component in the
 * project and prove nothing extra.
 *
 *   POST /auth              exchange the token for an intervention-scoped cookie
 *   GET  /i/:id             the intervention, plus a polled MASKED screenshot of the same page
 *   POST /i/:id/resume      release the HUMAN lease, hand back to the system
 *   POST /i/:id/abort       cancel the run
 *
 * ------------------------------------------------------------------------------------------------
 * [MUST] THERE IS NO /complete, AND NO LIST ENDPOINT
 * ------------------------------------------------------------------------------------------------
 * A human clicking a button must not be able to produce a successful capability result. `resume`
 * subsumes completion: the system re-observes, evaluates the success condition, validates every
 * declared output against its declared type, and declares success ITSELF with
 * `completionMode: 'human_assisted'`.
 *
 * "Only the system may declare success" is not a rule about models. It binds the operator in exactly
 * the same way, and this is where that is either true or a slogan. If the console had a `/complete`
 * button, the strongest claim this project makes would be false.
 *
 * No list endpoint, per PHASE 7: a per-run token must not become a directory of every run in flight.
 *
 * ------------------------------------------------------------------------------------------------
 * HOW THE PERSON ACTS
 * ------------------------------------------------------------------------------------------------
 * They use the visible browser window directly. It is already on their screen, already signed in,
 * already on the screen that stopped.
 *
 * A production console would stream the session - CDP screencast or WebRTC - and forward input
 * events back. The control-transfer model, the lease, the session-identity evidence and the resume
 * reconciliation are IDENTICAL under that transport; only the pixels and the input path differ. The
 * honest limit either way: direct OS input does not pass through the lease, which is why human acts
 * are witnessed rather than gated.
 */

export type ConsoleChoice = 'resume' | 'abort';

export interface ConsoleHandlers {
  /** The intervention as it stands now. `undefined` once it has been resolved and cleaned up. */
  get(id: string): Intervention | undefined;
  /** A fresh MASKED screenshot of the same page, as a data URI. */
  screenshot(id: string): Promise<string | null>;
  /** Called once, when the operator chooses. The run continues on its own thread. */
  choose(id: string, choice: ConsoleChoice, notes: string): Promise<void>;
}

export interface RunningConsole {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  banner(interventionId: string): string;
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Operator intervention</title>
<style>
  body { font: 13px system-ui, sans-serif; margin: 0; background: #f4f6f8; color: #16202b; }
  main { max-width: 980px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .sub { color: #5a6672; margin-bottom: 16px; }
  .card { background: #fff; border: 1px solid #d3dae1; border-radius: 6px; padding: 14px; margin-bottom: 14px; }
  dt { font-weight: 600; color: #5a6672; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  dd { margin: 2px 0 10px; }
  img { max-width: 100%; border: 1px solid #d3dae1; border-radius: 4px; display: block; }
  button { font: inherit; padding: 8px 16px; border-radius: 4px; border: 1px solid #1f3a5f; cursor: pointer; }
  .primary { background: #1f3a5f; color: #fff; }
  .danger { background: #fff; border-color: #a94442; color: #a94442; }
  input[type=password], textarea { font: inherit; padding: 6px; width: 100%; box-sizing: border-box; border: 1px solid #d3dae1; border-radius: 4px; }
  .note { background: #fff9dd; border: 1px solid #d8c86a; padding: 10px; border-radius: 4px; margin-bottom: 14px; }
  .done { padding: 14px; background: #e8f3e8; border: 1px solid #8fbf8f; border-radius: 6px; }
</style>
<main>
  <div id="gate" class="card">
    <h1>Operator token</h1>
    <p class="sub">Printed by the CLI on its own line. It is never part of this URL.</p>
    <p><input id="token" type="password" autocomplete="off" autofocus></p>
    <p><button class="primary" id="unlock">Unlock</button> <span id="gateError"></span></p>
  </div>

  <div id="panel" hidden>
    <h1 id="title">Intervention</h1>
    <p class="sub" id="subtitle"></p>

    <div class="note">
      <strong>Act in the browser window that is already open.</strong> It is the same live session
      the automation was driving - same context, same page, still signed in. When you are done,
      choose Resume. The system re-checks the screen and decides the outcome itself; there is no
      button here that marks the run successful.
    </div>

    <div class="card">
      <dl id="detail"></dl>
    </div>

    <div class="card">
      <dt>Live view (masked, refreshed every second)</dt>
      <img id="shot" alt="masked screenshot of the live session">
    </div>

    <div class="card">
      <dt>Notes (recorded in the evidence)</dt>
      <dd><textarea id="notes" rows="2"></textarea></dd>
      <p>
        <button class="primary" id="resume">Resume</button>
        <button class="danger" id="abort">Abort run</button>
      </p>
      <p id="choiceError"></p>
    </div>
  </div>

  <div id="finished" class="done" hidden></div>
</main>
<script>
  var id = location.pathname.split('/').pop();
  var poll = null;

  function show(sel, on) { document.querySelector(sel).hidden = !on; }

  document.getElementById('unlock').onclick = async function () {
    var res = await fetch('/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.getElementById('token').value, interventionId: id })
    });
    if (!res.ok) { document.getElementById('gateError').textContent = 'Rejected.'; return; }
    // The token is never stored. It bought a cookie; the cookie is HttpOnly and script cannot
    // read it, which is the point.
    document.getElementById('token').value = '';
    show('#gate', false); show('#panel', true);
    load(); poll = setInterval(refreshShot, 1000);
  };

  async function load() {
    var res = await fetch('/i/' + id + '/detail');
    if (!res.ok) return;
    var iv = await res.json();
    document.getElementById('title').textContent = iv.kind.replace(/_/g, ' ');
    document.getElementById('subtitle').textContent = iv.stopReason;
    var dl = document.getElementById('detail');
    dl.innerHTML = '';
    [['Capability', (iv.capabilityId || '-') + '@' + (iv.capabilityVersion || '-')],
     ['Step', iv.currentStep.id + ' (#' + iv.currentStep.index + ')'],
     ['Why this step exists', iv.currentStep.intent],
     ['Screen', iv.state.screenIdentity + (iv.state.visibleHeading ? ' - ' + iv.state.visibleHeading : '')],
     ['Last automated action', iv.previousAction || '(none)'],
     ['Run', iv.runId]].forEach(function (row) {
      var dt = document.createElement('dt'); dt.textContent = row[0];
      var dd = document.createElement('dd'); dd.textContent = row[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
    refreshShot();
  }

  async function refreshShot() {
    var res = await fetch('/i/' + id + '/screenshot');
    if (!res.ok) return;
    var body = await res.json();
    if (body.dataUri) document.getElementById('shot').src = body.dataUri;
  }

  async function choose(choice) {
    var res = await fetch('/i/' + id + '/' + choice, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: document.getElementById('notes').value })
    });
    if (!res.ok) {
      document.getElementById('choiceError').textContent = 'Refused: ' + res.status;
      return;
    }
    if (poll) clearInterval(poll);
    show('#panel', false);
    var done = document.getElementById('finished');
    done.textContent = choice === 'resume'
      ? 'Control handed back. The system is re-checking the screen and will decide the outcome itself.'
      : 'Run aborted.';
    done.hidden = false;
  }

  document.getElementById('resume').onclick = function () { choose('resume'); };
  document.getElementById('abort').onclick = function () { choose('abort'); };
</script>`;

export async function startOperatorConsole(
  handlers: ConsoleHandlers,
  options: { token: string; port?: number } = { token: '' },
): Promise<RunningConsole> {
  const secured = new OperatorConsole({ token: options.token });
  const app = secured.app;

  // ============================================================================================
  // [MUST] THE PAGE IS SERVED UNAUTHENTICATED. IT IS THE THING THAT ASKS FOR THE TOKEN.
  // ============================================================================================
  //
  // The first visit is unauthenticated BY CONSTRUCTION - that is what the token exchange is for -
  // so putting the session guard in front of the page makes the console impossible to open. It did:
  // the URL in the banner returned `{"error":"no valid console session"}` and there was no way to
  // enter a token anywhere.
  //
  // The page reveals nothing. It is a static form. Every route with data behind it, and every route
  // that changes anything, is mounted through `mountScoped` and needs the cookie.
  //
  // IT ALSO ANSWERS THE SAME WAY FOR AN UNKNOWN ID, deliberately. Returning 404 for an id that does
  // not exist would turn this into an oracle for which interventions are open, which is the same
  // enumeration attack the missing list endpoint exists to prevent. An unknown id gets the prompt,
  // and `/auth` then refuses it with the same 401 a bad token gets.
  app.get(interventionPath(':id'), (_req, res) => {
    res.type('html').send(PAGE);
  });

  secured.mountScoped('/i/:id/detail', 'get', (req, res) => {
    const intervention = handlers.get(req.params['id'] as string);
    if (intervention === undefined) {
      res.status(404).json({ error: 'no such open intervention' });
      return;
    }
    res.json(intervention);
  });

  secured.mountScoped('/i/:id/screenshot', 'get', (req, res) => {
    void handlers
      .screenshot(req.params['id'] as string)
      .then((dataUri) => res.json({ dataUri }))
      .catch(() => res.status(503).json({ dataUri: null }));
  });

  for (const choice of ['resume', 'abort'] as const) {
    secured.mountScoped('/i/:id/' + choice, 'post', (req, res) => {
      const body = req.body as { notes?: unknown };
      const notes = typeof body?.notes === 'string' ? body.notes : '';
      void handlers
        .choose(req.params['id'] as string, choice, notes)
        .then(() => res.json({ ok: true, choice }))
        .catch((error: unknown) =>
          res.status(409).json({ error: error instanceof Error ? error.message : 'refused' }),
        );
    });
  }

  // NOTE THE ABSENCE, deliberately, in the code and not only in a comment:
  //   there is no app.post('/i/:id/complete')
  //   there is no app.get('/i')
  // See the banner at the top of this file.

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(options.port ?? 0, CONSOLE_HOST, () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: 'http://' + CONSOLE_HOST + ':' + port,
    token: options.token,
    banner: (interventionId: string): string => {
      secured.register(interventionId);
      return consoleBanner(port, options.token, interventionId);
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * Brings the hook transport up at startup, and tears it down at quit.
 *
 * The pieces already live in modules: `prepareSocketFor`, `HookListener`,
 * `AgentSecrets`. The CLI harness orchestrates them for a measurement run; this
 * orchestrates the same modules for the real Electron shell, so nothing is
 * reimplemented. This is the wiring the shell was missing, not a rewrite of the
 * transport.
 *
 * It brings the socket up and no more. Nothing here consumes a hook event or
 * maps one to agent state: a connection that arrives is accepted and
 * acknowledged by `HookListener` per its existing design, and the `event` it
 * emits has no consumer yet. State derivation is a separate step on purpose, so
 * a transport failure stays attributable to the transport rather than tangled
 * with a mapping bug.
 *
 * The security-relevant properties are the socket's whole reason to exist and
 * they are the modules', preserved by using them rather than by this file:
 *  - the 0700 directory and owner-only socket on macOS, enforced and verified by
 *    `prepareSocketFor`, which refuses to start on a mode mismatch;
 *  - the named pipe on Windows, whose descriptor is not world-writable and whose
 *    authentication is per-agent secrets, not a shared token;
 *  - per-agent secrets through `AgentSecrets`, one instance held here, issued per
 *    agent as agents spawn later;
 *  - the constant-time acknowledgement and the connection cap, both inside
 *    `HookListener` and unchanged by being started from here;
 *  - no TCP: `net.createServer().listen(path)` binds a pipe or a socket file,
 *    never a port.
 */

import { assertStartable } from '../startup/self-check.ts';
import { prepareSocketFor, type SocketFs, type SocketSetupReport } from './socket-setup.ts';
import { HookListener } from './hook-listener.ts';
import { AgentSecrets } from './agent-secrets.ts';
import type { Platform } from '../platform/types.ts';
import type net from 'node:net';

export interface HookTransport {
    readonly listener: HookListener;
    /** Per-agent secrets. Empty at launch; agents issue into it when they spawn. */
    readonly secrets: AgentSecrets;
    readonly socketPath: string;
    readonly report: SocketSetupReport;
    /** The platform's own description of the socket's access, for the startup log. */
    readonly accessDetail: string;
}

export interface StartTransportOptions {
    readonly platform: Platform;
    readonly home: string;
    readonly appId: string;
    readonly maxConnections?: number;
    /** Injected in tests so a bind does not touch the real socket path or disk. */
    readonly createServer?: typeof net.createServer;
    readonly fs?: SocketFs;
}

/**
 * Prepares the socket and starts the listener. Throws rather than returning on a
 * mode mismatch or a bind failure, because a hook socket in the wrong place is an
 * exposure and half-starting is worse than not starting.
 *
 * Deliberately does not run `assertStartable`: that is agent-readiness (is the
 * Claude binary present, can a process be spawned) and is a separate launch gate
 * the caller runs, kept apart so a socket failure and a missing binary are two
 * different, attributable failures.
 */
export async function startHookTransport(options: StartTransportOptions): Promise<HookTransport> {
    const { plan, report } = prepareSocketFor(
        options.platform, { appId: options.appId, home: options.home }, options.fs
    );

    const secrets = new AgentSecrets();
    const listener = new HookListener({
        socketPath: plan.path,
        secrets,
        ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
        ...(options.createServer === undefined ? {} : { createServer: options.createServer })
    });
    await listener.listen();

    return { listener, secrets, socketPath: plan.path, report, accessDetail: plan.accessDetail };
}

/** Closes the listener, which releases the pipe and unlinks the socket file. */
export async function stopHookTransport(transport: HookTransport): Promise<void> {
    await transport.listener.close();
}

/**
 * The agent-readiness gate the shell runs at launch, the refusing form. Throws if
 * the platform is unsupported or a self-check fails, so a machine that cannot run
 * an agent refuses rather than presenting a tray that does nothing.
 *
 * The `canSpawnAndKill` prober is required, not optional, because the self-check
 * framework scores an unproved spawn-and-kill as a failure rather than a pass:
 * passing by finding nothing is the thing the project forbids. So the caller
 * hands in a real prober, and this actually spawns and kills, the same as the
 * harness does. The prober is injected rather than built here so this module does
 * not import node-pty.
 *
 * Separate from the transport on purpose: no Claude binary and a bad socket mode
 * are different failures and must not share a symptom.
 */
export function assertLaunchable(
    platform: Platform, home: string, appId: string, canSpawnAndKill: () => boolean
): void {
    assertStartable(platform, { home, appId, claudePath: null }, { canSpawnAndKill });
}

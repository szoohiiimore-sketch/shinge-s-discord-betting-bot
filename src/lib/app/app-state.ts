/**
 * Application lifecycle states.
 *
 * State transitions:
 *   NOT_STARTED → STARTING → RUNNING
 *   RUNNING     → STOPPING → STOPPED
 *   STARTING    → FAILED
 *   RUNNING     → FAILED
 *   STOPPING    → FAILED
 *
 * FAILED is a terminal state. The process must exit after entering FAILED.
 */
export enum ApplicationState {
  /** Initial state before start() is called */
  NOT_STARTED = 'NOT_STARTED',
  /** Startup sequence in progress */
  STARTING = 'STARTING',
  /** All dependencies initialized, accepting requests */
  RUNNING = 'RUNNING',
  /** Shutdown sequence in progress */
  STOPPING = 'STOPPING',
  /** Clean shutdown complete */
  STOPPED = 'STOPPED',
  /** Startup or runtime failure — terminal state */
  FAILED = 'FAILED',
}

/** Valid transitions from each state */
const VALID_TRANSITIONS: Record<ApplicationState, ApplicationState[]> = {
  [ApplicationState.NOT_STARTED]: [ApplicationState.STARTING],
  [ApplicationState.STARTING]: [ApplicationState.RUNNING, ApplicationState.FAILED],
  [ApplicationState.RUNNING]: [ApplicationState.STOPPING, ApplicationState.FAILED],
  [ApplicationState.STOPPING]: [ApplicationState.STOPPED, ApplicationState.FAILED],
  [ApplicationState.STOPPED]: [],
  [ApplicationState.FAILED]: [],
};

/**
 * Validates a state transition.
 *
 * @throws {Error} If the transition is invalid
 */
export function assertValidTransition(
  current: ApplicationState,
  next: ApplicationState,
): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    throw new Error(
      `Invalid state transition: ${current} → ${next}. ` +
      `Allowed transitions from ${current}: [${allowed?.join(', ') ?? 'none'}]`,
    );
  }
}

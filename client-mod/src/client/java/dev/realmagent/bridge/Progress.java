package dev.realmagent.bridge;

/**
 * Tick-rate progress scoring, so stagnation is measured rather than guessed and the model can be
 * handed a diagnosis instead of raw experience.
 *
 * Callers report *remaining work* on every tick — blocks left to a goal, ticks left in a window —
 * and the tracker turns the sequence into a fraction of recent ticks that actually advanced. A
 * long-running action that is genuinely stuck looks different here from one that is merely slow,
 * which is the distinction a fixed timeout cannot make.
 */
final class Progress {
    private static final int WINDOW = 40; // two seconds of ticks
    private static final double EPSILON = 1e-3;
    private final boolean[] advanced = new boolean[WINDOW];
    private int index, filled, stagnant;
    private double remaining = Double.NaN, best = Double.NaN;

    void reset(double startingRemaining) {
        index = filled = stagnant = 0;
        java.util.Arrays.fill(advanced, false);
        remaining = best = startingRemaining;
    }
    void sample(double currentRemaining) {
        boolean moved = !Double.isNaN(remaining) && remaining - currentRemaining > EPSILON;
        advanced[index] = moved;
        index = (index + 1) % WINDOW;
        if (filled < WINDOW) filled++;
        stagnant = moved ? 0 : stagnant + 1;
        remaining = currentRemaining;
        if (Double.isNaN(best) || currentRemaining < best) best = currentRemaining;
    }
    /** Fraction of the recent window that advanced. Zero means stuck, not merely slow. */
    double score() {
        if (filled == 0) return 1.0;
        int count = 0;
        for (int i = 0; i < filled; i++) if (advanced[i]) count++;
        return (double) count / filled;
    }
    int stagnantTicks() { return stagnant; }
    double remaining() { return remaining; }
    /** How much of the original work was ever completed, even if we then slid backwards. */
    double best() { return best; }
}

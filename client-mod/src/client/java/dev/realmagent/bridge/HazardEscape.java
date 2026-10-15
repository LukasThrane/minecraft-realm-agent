package dev.realmagent.bridge;

/**
 * Where to stand when the ground itself is what is killing us.
 *
 * The task layer already refuses to walk into lava, and that refusal is right, but refusing to
 * move is not an escape: observed live, a gather hit `hazard_ahead`, the task failed, the body
 * stopped exactly where it was, and the character burned to death over the twenty seconds the
 * agent spent deciding what to do about it. Contact with lava is not a decision -- there is one
 * correct answer and no time to ask for it -- so the safety tier owns this and picks the spot.
 *
 * Pure geometry over a voxel view, so the choice is testable without a client.
 */
final class HazardEscape {
    interface World {
        boolean hazard(int x, int y, int z);
        boolean solid(int x, int y, int z);
        boolean known(int x, int y, int z);
    }
    record Spot(int x, int y, int z) {}
    static final int RADIUS = 8, RISE = 4, DROP = 4;

    /**
     * The closest place we could stand unharmed, preferring clearance from the hazard and then
     * distance. Searched twice: once demanding a block of margin, and if the lake is wider than
     * that, once for anywhere merely not on fire -- because a bad shore beats the middle.
     */
    static Spot nearest(World world, int x, int y, int z) {
        Spot clear = nearest(world, x, y, z, 1);
        return clear != null ? clear : nearest(world, x, y, z, 0);
    }
    static Spot nearest(World world, int px, int py, int pz, int margin) {
        Spot best = null;
        double bestScore = Double.MAX_VALUE;
        for (int dy = RISE; dy >= -DROP; dy--)
            for (int dx = -RADIUS; dx <= RADIUS; dx++)
                for (int dz = -RADIUS; dz <= RADIUS; dz++) {
                    int x = px + dx, y = py + dy, z = pz + dz;
                    if (!stands(world, x, y, z, margin)) continue;
                    // Climbing out beats dropping further in, and a drop might be into more of it.
                    double score = Math.hypot(dx, dz) + Math.abs(dy) * 1.5 + (dy < 0 ? 3 : 0);
                    if (score < bestScore) { bestScore = score; best = new Spot(x, y, z); }
                }
        return best;
    }
    /** Room for the body, floor under it, and nothing burning within the margin of any of it. */
    static boolean stands(World world, int x, int y, int z, int margin) {
        if (!world.known(x, y, z) || !world.known(x, y + 1, z) || !world.known(x, y - 1, z)) return false;
        if (world.solid(x, y, z) || world.solid(x, y + 1, z) || !world.solid(x, y - 1, z)) return false;
        for (int ox = -margin; ox <= margin; ox++)
            for (int oy = -margin; oy <= 1 + margin; oy++)
                for (int oz = -margin; oz <= margin; oz++)
                    if (world.hazard(x + ox, y + oy, z + oz)) return false;
        return true;
    }
}

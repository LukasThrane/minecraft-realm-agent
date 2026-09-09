package dev.windove.bridge;

import com.google.gson.*;
import net.minecraft.client.Minecraft;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Enemy;
import java.util.Set;

/**
 * The action envelope required by the plan's section 4.
 *
 * Every action, at any level, carries the same identity, freshness, deadline and policy scope,
 * and produces the same shaped outcome with before/after observations. Adding a skill later
 * means adding a case here, not inventing a second way to move the player.
 *
 * Validation runs on the HTTP thread and touches no game state, so a malformed request is
 * rejected before it can reach a tick. The tick revalidates preconditions regardless.
 */
final class Actions {
    static final Set<String> TYPES = Set.of("navigate", "move", "look", "jump", "select", "respawn", "break", "place");
    static final Set<String> DIRECTIONS = Set.of("forward", "back", "left", "right");
    /** Forbids breaking and placement. Relocation always runs here, so travel cannot change terrain. */
    static final String SCOPE_TRAVEL = "travel";
    /**
     * Permits breaking and placement. Kept as a distinct scope because gate 5 needs somewhere to
     * hang region policy, and because an outcome should record which authority it ran under.
     * It is not a location restriction: where to test is the operator's decision.
     */
    static final String SCOPE_BUILD = "build";
    static final Set<String> BUILD_TYPES = Set.of("break", "place");
    /**
     * Typed failure. Free text cannot be matched against a remedy later, which is the whole
     * mechanism MineEvolve's gains rest on, so every non-success carries one of these.
     */
    static final String FAIL_NONE = "", FAIL_NO_PROGRESS = "no_progress", FAIL_DEADLINE = "deadline",
        FAIL_PRECONDITION = "precondition", FAIL_INTERRUPTED = "interrupted", FAIL_TAKEOVER = "takeover",
        FAIL_ASSUMPTION = "assumption_violated", FAIL_CONTROLLER = "controller_error", FAIL_SAFETY = "safety_preempted";
    private Actions() {}

    static JsonObject validate(JsonObject request) {
        String type = string(request, "type");
        if (!TYPES.contains(type)) throw new IllegalArgumentException("Unsupported action type");
        String scope = string(request, "scope");
        if (!SCOPE_TRAVEL.equals(scope) && !SCOPE_BUILD.equals(scope)) throw new IllegalArgumentException("Unknown policy scope");
        if (BUILD_TYPES.contains(type) != SCOPE_BUILD.equals(scope)) throw new IllegalArgumentException("Block modification requires the build scope, and only block modification may use it");
        String id = string(request, "actionId");
        if (id.isEmpty() || id.length() > 80) throw new IllegalArgumentException("Invalid actionId");
        long deadline = number(request, "deadlineMs");
        if (deadline < 1000 || deadline > 600_000) throw new IllegalArgumentException("deadlineMs must be 1000..600000");
        if (request.has("assumes")) validateAssumptions(request.getAsJsonObject("assumes"));
        JsonObject args = request.has("args") && request.get("args").isJsonObject() ? request.getAsJsonObject("args") : new JsonObject();
        switch (type) {
            case "navigate" -> {
                double x = decimal(args, "x"), z = decimal(args, "z");
                if (x != Math.rint(x) || z != Math.rint(z)) throw new IllegalArgumentException("Coordinates must be integers");
                if (Math.abs(x) > 29_000_000 || Math.abs(z) > 29_000_000) throw new IllegalArgumentException("Coordinates outside world bounds");
            }
            case "move" -> {
                if (!DIRECTIONS.contains(string(args, "direction"))) throw new IllegalArgumentException("direction must be forward, back, left or right");
                long ticks = number(args, "ticks");
                // Bounded by construction: a low-level action cannot become an open-ended one.
                if (ticks < 1 || ticks > 100) throw new IllegalArgumentException("ticks must be 1..100");
            }
            case "look" -> {
                double yaw = decimal(args, "yaw"), pitch = decimal(args, "pitch");
                if (!Double.isFinite(yaw) || !Double.isFinite(pitch)) throw new IllegalArgumentException("yaw and pitch must be finite");
                if (Math.abs(yaw) > 360 || Math.abs(pitch) > 180) throw new IllegalArgumentException("yaw must be within 360 and pitch within 180 degrees");
            }
            case "break" -> {
                long ticks = number(args, "ticks");
                if (ticks < 1 || ticks > 200) throw new IllegalArgumentException("ticks must be 1..200");
            }
            case "select" -> {
                long slot = number(args, "slot");
                if (slot < 0 || slot > 8) throw new IllegalArgumentException("slot must be a hotbar slot 0..8");
            }
            default -> { }
        }
        return request;
    }

    /**
     * The propositions a decision depended on. Checked when the action starts and on every tick
     * after, so a decision dies when what it assumed stops being true rather than when a clock
     * says it is old. A timestamp rejects the merely stale and admits the recently catastrophic.
     */
    static void validateAssumptions(JsonObject assumes) {
        for (String key : assumes.keySet()) {
            switch (key) {
                case "minHealth" -> { double value = decimal(assumes, key); if (!(value >= 0 && value <= 1024)) throw new IllegalArgumentException("minHealth out of range"); }
                case "holding" -> { if (string(assumes, key).isEmpty()) throw new IllegalArgumentException("holding must be an item id"); }
                case "maxHostilesWithin" -> {
                    JsonObject limit = assumes.getAsJsonObject(key);
                    double radius = decimal(limit, "radius");
                    if (!(radius > 0 && radius <= Observations.MAX_RADIUS)) throw new IllegalArgumentException("radius must be 0.." + Observations.MAX_RADIUS);
                    if (number(limit, "count") < 0) throw new IllegalArgumentException("count must not be negative");
                }
                default -> throw new IllegalArgumentException("Unknown assumption: " + key);
            }
        }
    }
    /** Returns the violated assumption, or empty when all still hold. Reads no input, writes nothing. */
    static String violated(JsonObject assumes, Minecraft mc) {
        if (assumes == null || mc.player == null || mc.level == null) return "";
        for (String key : assumes.keySet()) {
            switch (key) {
                case "minHealth" -> { if (mc.player.getHealth() < decimal(assumes, key)) return key; }
                case "holding" -> {
                    var held = mc.player.getInventory().getSelectedItem();
                    if (!String.valueOf(BuiltInRegistries.ITEM.getKey(held.getItem())).equals(string(assumes, key))) return key;
                }
                case "maxHostilesWithin" -> {
                    JsonObject limit = assumes.getAsJsonObject(key);
                    double radius = decimal(limit, "radius");
                    long count = 0;
                    for (Entity entity : mc.level.entitiesForRendering())
                        if (entity != mc.player && entity.isAlive() && entity instanceof Enemy && entity.distanceTo(mc.player) <= radius) count++;
                    if (count > number(limit, "count")) return key;
                }
                default -> { }
            }
        }
        return "";
    }

    /** The before/after observation both halves of an outcome are measured against. */
    static JsonObject snapshot(Minecraft mc, long tick) {
        JsonObject at = new JsonObject();
        at.addProperty("tick", tick);
        at.addProperty("atMs", System.currentTimeMillis());
        if (mc.player == null) { at.addProperty("online", false); return at; }
        at.addProperty("online", true);
        at.addProperty("x", mc.player.getX()); at.addProperty("y", mc.player.getY()); at.addProperty("z", mc.player.getZ());
        at.addProperty("yaw", mc.player.getYRot()); at.addProperty("pitch", mc.player.getXRot());
        at.addProperty("onGround", mc.player.onGround());
        at.addProperty("health", mc.player.getHealth());
        at.addProperty("selectedSlot", mc.player.getInventory().getSelectedSlot());
        return at;
    }

    /** What actually changed, in the terms each action is judged by. Never a restatement of intent. */
    static JsonObject evidence(String type, JsonObject before, JsonObject after, double peakY) {
        JsonObject evidence = new JsonObject();
        if (!before.get("online").getAsBoolean() || !after.get("online").getAsBoolean()) return evidence;
        double dx = after.get("x").getAsDouble() - before.get("x").getAsDouble();
        double dz = after.get("z").getAsDouble() - before.get("z").getAsDouble();
        evidence.addProperty("displacement", Math.hypot(dx, dz));
        evidence.addProperty("elapsedTicks", after.get("tick").getAsLong() - before.get("tick").getAsLong());
        switch (type) {
            case "look" -> {
                evidence.addProperty("yawChange", wrap(after.get("yaw").getAsDouble() - before.get("yaw").getAsDouble()));
                evidence.addProperty("pitchChange", after.get("pitch").getAsDouble() - before.get("pitch").getAsDouble());
            }
            case "jump" -> evidence.addProperty("peakRise", peakY - before.get("y").getAsDouble());
            case "break", "place" -> { }
            case "select" -> {
                evidence.addProperty("slotBefore", before.get("selectedSlot").getAsInt());
                evidence.addProperty("slotAfter", after.get("selectedSlot").getAsInt());
            }
            default -> evidence.addProperty("verticalChange", after.get("y").getAsDouble() - before.get("y").getAsDouble());
        }
        return evidence;
    }
    private static double wrap(double degrees) { return Math.IEEEremainder(degrees, 360.0); }
    static String string(JsonObject object, String key) { return object.has(key) && object.get(key).isJsonPrimitive() ? object.get(key).getAsString() : ""; }
    static long number(JsonObject object, String key) {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()) throw new IllegalArgumentException("Missing " + key);
        double value = object.get(key).getAsDouble();
        if (value != Math.rint(value) || !Double.isFinite(value)) throw new IllegalArgumentException(key + " must be a whole number");
        return (long) value;
    }
    static double decimal(JsonObject object, String key) {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()) throw new IllegalArgumentException("Missing " + key);
        return object.get(key).getAsDouble();
    }
}

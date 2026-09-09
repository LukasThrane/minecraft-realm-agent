package dev.windove.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import java.util.*;

/**
 * Where the stations are, remembered for as long as the world lasts.
 *
 * A scan around the player forgets a crafting table the moment the miner walks past its radius,
 * so every gather trip came home to a planner that believed it owned no table and cheerfully
 * crafted another one. Placement is a fact about the world, not about where we happen to be
 * standing, so it is recorded once and kept.
 *
 * Kept honest in one direction only. An entry is dropped when its chunk is loaded and the block
 * is demonstrably gone; an entry in an unloaded chunk is retained, because not being able to see
 * something is not evidence that it is absent. The bound below is a policy about what counts as
 * usable, not a claim that everything inside it can be reached.
 */
final class Stations {
    /**
     * How far a remembered station may be and still be offered to the planner as one we own.
     *
     * A trade, not a reachability claim: walking a few hundred blocks back to a furnace beats
     * mining eight more cobblestone, while a base from an earlier session does not. Comfortably
     * wider than a gathering trip, so drifting away from the worksite is never what loses us a
     * table. Beyond it the planner is told nothing and will build a new one.
     */
    static final int USABLE_RANGE = 256;
    private static final int SCAN_H = 24, SCAN_V = 12, RESCAN_MS = 1000, RESCAN_DISTANCE_SQ = 16;

    private static final Map<BlockPos, String> known = new LinkedHashMap<>();
    private static Level level;
    private static long scannedAt;
    private static BlockPos scannedFrom;

    private Stations() {}

    /** Drop the local scan cache without forgetting placements. Called when a skill ends. */
    static void invalidateScan() { scannedAt = 0; }

    /** A different world is a different set of stations; nothing carries over. */
    static void forget() { known.clear(); level = null; scannedAt = 0; scannedFrom = null; }

    private static String kindAt(Level world, BlockPos position) {
        var block = world.getBlockState(position).getBlock();
        if (block == Blocks.CRAFTING_TABLE) return "crafting_table";
        if (block == Blocks.FURNACE) return "furnace";
        return null;
    }

    /** Record a station we placed or opened, so it survives walking away from it. */
    static void record(Minecraft mc, BlockPos position, String kind) {
        if (mc.level == null || kind == null) return;
        if (level != mc.level) forget();
        level = mc.level;
        known.put(position.immutable(), kind);
    }

    /**
     * Merge a local scan into memory and prune what the loaded world contradicts. Rate-limited the
     * same way the previous scan was: this runs on the client tick and must not cost more than it
     * did before memory existed.
     */
    static void refresh(Minecraft mc) {
        if (mc.player == null || mc.level == null) { return; }
        if (level != mc.level) forget();
        level = mc.level;
        BlockPos at = mc.player.blockPosition();
        long now = System.currentTimeMillis();
        if (scannedFrom != null && now - scannedAt < RESCAN_MS && scannedFrom.distSqr(at) <= RESCAN_DISTANCE_SQ) return;
        scannedAt = now; scannedFrom = at.immutable();
        for (BlockPos position : BlockPos.betweenClosed(at.offset(-SCAN_H, -SCAN_V, -SCAN_H), at.offset(SCAN_H, SCAN_V, SCAN_H))) {
            if (!mc.level.hasChunkAt(position)) continue;
            String kind = kindAt(mc.level, position);
            if (kind != null) known.put(position.immutable(), kind);
        }
        // Only a loaded chunk can disprove a remembered station.
        known.entrySet().removeIf(entry -> mc.level.hasChunkAt(entry.getKey())
            && !entry.getValue().equals(kindAt(mc.level, entry.getKey())));
    }

    /** Remembered positions of one kind, nearest first, bounded by what counts as usable. */
    static List<BlockPos> nearest(Minecraft mc, String kind) {
        if (mc.player == null || mc.level == null || level != mc.level) return List.of();
        BlockPos at = mc.player.blockPosition();
        List<BlockPos> found = new ArrayList<>();
        for (var entry : known.entrySet())
            if (entry.getValue().equals(kind) && Math.sqrt(entry.getKey().distSqr(at)) <= USABLE_RANGE) found.add(entry.getKey());
        found.sort(Comparator.comparingDouble(position -> position.distSqr(at)));
        return found;
    }

    /** The names the planner reads: which stations we own, whether or not we are standing by one. */
    static Set<String> kinds(Minecraft mc) {
        Set<String> names = new LinkedHashSet<>();
        for (String kind : List.of("crafting_table", "furnace")) if (!nearest(mc, kind).isEmpty()) names.add(kind);
        return names;
    }

    /** The same knowledge with coordinates, for a caller that wants to go there rather than count. */
    static JsonArray sites(Minecraft mc) {
        JsonArray array = new JsonArray();
        if (mc.player == null) return array;
        BlockPos at = mc.player.blockPosition();
        for (String kind : List.of("crafting_table", "furnace")) for (BlockPos position : nearest(mc, kind)) {
            JsonObject site = new JsonObject();
            site.addProperty("kind", kind);
            site.addProperty("x", position.getX()); site.addProperty("y", position.getY()); site.addProperty("z", position.getZ());
            site.addProperty("distance", Math.round(Math.sqrt(position.distSqr(at)) * 10) / 10.0);
            site.addProperty("verified", mc.level != null && mc.level.hasChunkAt(position));
            array.add(site);
        }
        return array;
    }
}

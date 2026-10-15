package dev.realmagent.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.item.ItemStack;

/**
 * The safety tier of the arbiter, running on the client tick.
 *
 * This exists because deliberation takes seconds and a creeper does not wait. Everything here is
 * deterministic and lives in the mod, so it keeps working while the agent process is thinking,
 * slow, disconnected or dead. Priority is manual takeover, then safety, then task: a reflex
 * preempts a running action and the action ends as cancelled with `safety_preempted`, so the
 * agent learns why its goal stopped rather than seeing it vanish.
 *
 * Threat assessment and movement live in Survival; this class owns physiological maintenance.
 */
final class Reflexes {
    static final String NONE = "", RETREAT = "retreat", EAT = "eat", SURFACE = "surface", ESCAPE = "escape";
    /** Vanilla air is 300 ticks. Act well before it runs out, and keep going until it is refilled. */
    static final int AIR_LOW = 160, AIR_RECOVERED = 280;
    static final int EAT_BELOW_FOOD = 6, EAT_MAX_TICKS = 60;

    private Reflexes() {}

    /** Hotbar slot holding something edible, or -1. Hotbar only: no container or inventory access. */
    /**
     * Food that costs more than it gives: rotten flesh and its friends trade hunger for poison or
     * nausea. Worth eating only when the alternative is starving, never as routine maintenance.
     */
    private static final java.util.Set<String> LAST_RESORT_FOOD = java.util.Set.of(
        "rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken", "suspicious_stew");
    private static boolean grim(ItemStack stack) {
        return LAST_RESORT_FOOD.contains(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath());
    }
    static int foodSlot(Minecraft mc) { return foodSlot(mc, mc != null && mc.player != null && mc.player.getFoodData().getFoodLevel() <= 2); }
    static int foodSlot(Minecraft mc, boolean desperate) {
        if (mc.player == null) return -1;
        var bag = mc.player.getInventory();
        int fallback = -1;
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = bag.getItem(slot);
            if (stack.isEmpty() || !stack.has(DataComponents.FOOD)) continue;
            if (!grim(stack)) return slot;
            if (fallback < 0) fallback = slot;
        }
        return desperate ? fallback : -1;
    }
    /** Blocks that hurt on contact rather than at a distance. Lava is the one that kills fast. */
    private static final java.util.Set<String> CONTACT = java.util.Set.of(
        "lava", "fire", "soul_fire", "magma_block", "campfire", "soul_campfire");
    /**
     * Are we standing in something that is burning us right now?
     *
     * Not merely on fire: a character alight on grass is losing health the eating reflex can
     * cover, while a character in lava has about four seconds. Only contact with the source is
     * worth taking the body for.
     */
    static boolean burning(Minecraft mc) {
        if (mc.player == null || mc.level == null) return false;
        if (mc.player.isInLava()) return true;
        var box = mc.player.getBoundingBox();
        for (net.minecraft.core.BlockPos pos : net.minecraft.core.BlockPos.betweenClosed(
                net.minecraft.core.BlockPos.containing(box.minX + 0.05, box.minY - 0.08, box.minZ + 0.05),
                net.minecraft.core.BlockPos.containing(box.maxX - 0.05, box.maxY, box.maxZ - 0.05))) {
            if (!mc.level.hasChunkAt(pos)) continue;
            if (mc.level.getFluidState(pos).is(net.minecraft.tags.FluidTags.LAVA)) return true;
            if (CONTACT.contains(net.minecraft.core.registries.BuiltInRegistries.BLOCK
                    .getKey(mc.level.getBlockState(pos).getBlock()).getPath())) return true;
        }
        return false;
    }
    static boolean drowning(Minecraft mc) {
        return mc.player != null && mc.player.isUnderWater() && mc.player.getAirSupply() < AIR_LOW;
    }
    /** Vanilla regenerates health only while food is nearly full, so being hurt is a reason to eat. */
    static final int EAT_TO_HEAL_FOOD = 20;
    static boolean hurt(Minecraft mc) {
        return mc.player.getHealth() < mc.player.getMaxHealth();
    }
    static String maintenance(Minecraft mc) {
        if (drowning(mc)) return SURFACE;
        if (mc.player.getFoodData().getFoodLevel() <= EAT_BELOW_FOOD && foodSlot(mc) >= 0) return EAT;
        // Being hurt with food in the bag and a half-empty bar is a reason to eat now, not after
        // the bar runs down: regeneration is what turns a bad fight into a survivable one.
        if (hurt(mc) && mc.player.getFoodData().getFoodLevel() < EAT_TO_HEAL_FOOD && foodSlot(mc) >= 0) return EAT;
        return NONE;
    }
    static boolean stillNeeded(Minecraft mc, String active) {
        if (mc.player == null) return false;
        return switch (active) {
            case SURFACE -> mc.player.isInWater() && mc.player.getAirSupply() < AIR_RECOVERED;
            case EAT -> mc.player.getFoodData().getFoodLevel() < (hurt(mc) ? EAT_TO_HEAL_FOOD : EAT_BELOW_FOOD + 4) && foodSlot(mc) >= 0;
            default -> false;
        };
    }
}

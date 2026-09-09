package dev.windove.bridge;

import net.minecraft.client.Minecraft;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Enemy;
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
 * Deliberately conservative. Retreat backs away from the nearest hostile and is capped, because a
 * client-side reflex cannot see a cliff or lava it might be reversing into; it buys seconds for a
 * slower layer to decide, and is not a survival guarantee.
 */
final class Reflexes {
    static final String NONE = "", RETREAT = "retreat", EAT = "eat", SURFACE = "surface";
    /** Vanilla air is 300 ticks. Act well before it runs out, and keep going until it is refilled. */
    static final int AIR_LOW = 160, AIR_RECOVERED = 280;
    /** Hysteresis: a reflex must clear by a wider margin than it triggered, or it chatters. */
    static final double TRIGGER_RADIUS = 5.0, CLEAR_RADIUS = 8.0;
    static final int EAT_BELOW_FOOD = 6, RETREAT_MAX_TICKS = 60, EAT_MAX_TICKS = 60, SURFACE_MAX_TICKS = 200;

    private Reflexes() {}

    static Entity nearestHostile(Minecraft mc, double radius) {
        if (mc.player == null || mc.level == null) return null;
        Entity nearest = null;
        double best = radius;
        for (Entity entity : mc.level.entitiesForRendering()) {
            if (entity == mc.player || !entity.isAlive() || !(entity instanceof Enemy)) continue;
            double distance = entity.distanceTo(mc.player);
            if (distance <= best) { best = distance; nearest = entity; }
        }
        return nearest;
    }
    /** Hotbar slot holding something edible, or -1. Hotbar only: no container or inventory access. */
    static int foodSlot(Minecraft mc) {
        if (mc.player == null) return -1;
        var bag = mc.player.getInventory();
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = bag.getItem(slot);
            if (!stack.isEmpty() && stack.has(DataComponents.FOOD)) return slot;
        }
        return -1;
    }
    static boolean drowning(Minecraft mc) {
        return mc.player != null && mc.player.isUnderWater() && mc.player.getAirSupply() < AIR_LOW;
    }
    /**
     * Which reflex the current world state calls for, ignoring whatever is already running.
     * Drowning outranks a mob: water kills on its own schedule whether or not anything is chasing,
     * and a retreat that runs into a lake was previously how this agent died.
     */
    static String wanted(Minecraft mc) {
        if (mc.player == null || mc.level == null) return NONE;
        if (drowning(mc)) return SURFACE;
        if (nearestHostile(mc, TRIGGER_RADIUS) != null) return RETREAT;
        if (mc.player.getFoodData().getFoodLevel() <= EAT_BELOW_FOOD && foodSlot(mc) >= 0) return EAT;
        return NONE;
    }
    /** Whether a running reflex should keep going. Wider than the trigger, so it does not chatter. */
    static boolean stillNeeded(Minecraft mc, String active) {
        if (mc.player == null) return false;
        return switch (active) {
            case SURFACE -> mc.player.isInWater() && mc.player.getAirSupply() < AIR_RECOVERED;
            case RETREAT -> nearestHostile(mc, CLEAR_RADIUS) != null;
            case EAT -> mc.player.getFoodData().getFoodLevel() <= EAT_BELOW_FOOD + 4 && foodSlot(mc) >= 0;
            default -> false;
        };
    }
    /** Yaw that points directly away from a threat. */
    static float awayFrom(Minecraft mc, Entity threat) {
        double dx = mc.player.getX() - threat.getX(), dz = mc.player.getZ() - threat.getZ();
        return (float) (Math.toDegrees(Math.atan2(-dx, dz)));
    }

    static Float escapeYaw(Minecraft mc, Entity threat) {
        float away=awayFrom(mc,threat);
        for(int offset:new int[]{0,45,-45,90,-90,135,-135,180}) {
            float yaw=away+offset;
            double radians=Math.toRadians(yaw);
            double dx=-Math.sin(radians), dz=Math.cos(radians);
            var next=mc.player.getBoundingBox().move(dx,0,dz);
            boolean clear=mc.level.noCollision(mc.player,next);
            boolean step=mc.player.onGround() && mc.level.noCollision(mc.player,next.move(0,1,0));
            if(!clear && !step) continue;
            var feet=net.minecraft.core.BlockPos.containing(mc.player.getX()+dx,mc.player.getY(),mc.player.getZ()+dz);
            boolean supported=false, hazardous=false;
            for(int depth=0;depth<=3;depth++) {
                var at=feet.below(depth);
                var block=mc.level.getBlockState(at);
                if(!mc.level.getFluidState(at).isEmpty()) { hazardous=true;break; }
                if(!block.getCollisionShape(mc.level,at).isEmpty()) supported=true;
            }
            if(!mc.player.isInWater() && (!supported || hazardous)) continue;
            return yaw;
        }
        return null;
    }
}

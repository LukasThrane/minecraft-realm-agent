package dev.realmagent.bridge;

import com.google.gson.*;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import java.util.*;

/**
 * Read-only world snapshot built on the client tick. Reads no input and writes no game state.
 *
 * Everything here is what this client has been told, so it shares the client's blind spots:
 * entities outside loaded chunks are absent, and mob AI targets are server state that never
 * reaches us. Threat has to be inferred from type, distance and health, not from an intent flag.
 */
final class Observations {
    static final int MAX_RADIUS = 48, MAX_ENTITIES = 64;
    private Observations() {}

    static void invalidateStations() { Stations.invalidateScan(); }

    static JsonObject build(Minecraft mc) {
        JsonObject out = new JsonObject();
        LocalPlayer player = mc.player;
        var level = mc.level;
        if (player == null || level == null) { out.addProperty("online", false); return out; }
        BlockPos at = player.blockPosition();
        out.addProperty("online", true);
        out.addProperty("gameTime", level.getGameTime());
        out.addProperty("raining", level.isRaining());
        out.addProperty("thundering", level.isThundering());
        // Light, not clock time: this is what actually governs hostile spawning around us.
        out.addProperty("light", level.getMaxLocalRawBrightness(at));
        out.addProperty("skyLight", level.getEffectiveSkyBrightness(at));
        out.addProperty("radius", MAX_RADIUS);
        out.add("self", self(player));
        out.add("entities", entities(level.entitiesForRendering(), player));
        out.add("inventory", inventory(player));
        // Stations are remembered rather than rescanned, so walking away from a table we placed
        // does not convince the planner it needs to craft another one.
        Stations.refresh(mc);
        JsonArray stations=new JsonArray();
        for(String station:Stations.kinds(mc)) stations.add(station);
        out.add("stations",stations);
        // Items we have left in a furnace. Inventory alone cannot see them, and planning from
        // inventory alone is what made the agent go back for ore that was already smelting.
        JsonObject smelting=new JsonObject();
        Skills.pending().forEach(smelting::addProperty);
        out.add("smelting",smelting);
        out.add("stationSites",Stations.sites(mc));
        return out;
    }

    /**
     * A compact sample for the history ring. Small on purpose: history is about what changed over
     * time, and every system surveyed feeds its planner a sequence rather than one instant. Twenty
     * numbers per sample beats twenty frames for anything that reasons in text.
     */
    static JsonObject digest(Minecraft mc, long tick) {
        JsonObject at = new JsonObject();
        at.addProperty("tick", tick);
        at.addProperty("atMs", System.currentTimeMillis());
        LocalPlayer player = mc.player;
        if (player == null || mc.level == null) { at.addProperty("online", false); return at; }
        at.addProperty("online", true);
        at.addProperty("x", Math.round(player.getX() * 10) / 10.0);
        at.addProperty("y", Math.round(player.getY() * 10) / 10.0);
        at.addProperty("z", Math.round(player.getZ() * 10) / 10.0);
        at.addProperty("health", player.getHealth());
        at.addProperty("food", player.getFoodData().getFoodLevel());
        at.addProperty("light", mc.level.getMaxLocalRawBrightness(player.blockPosition()));
        int hostiles = 0;
        double nearest = Double.NaN;
        for (Entity entity : mc.level.entitiesForRendering()) {
            if (entity == player || !entity.isAlive() || !(entity instanceof Enemy)) continue;
            double distance = entity.distanceTo(player);
            if (distance > MAX_RADIUS) continue;
            hostiles++;
            if (Double.isNaN(nearest) || distance < nearest) nearest = distance;
        }
        at.addProperty("hostiles", hostiles);
        if (!Double.isNaN(nearest)) at.addProperty("nearestHostile", Math.round(nearest * 10) / 10.0);
        int used = 0;
        var bag = player.getInventory();
        for (int slot = 0; slot < bag.getContainerSize(); slot++) if (!bag.getItem(slot).isEmpty()) used++;
        at.addProperty("inventoryUsed", used);
        return at;
    }

    private static JsonObject self(LocalPlayer player) {
        JsonObject self = new JsonObject();
        self.addProperty("x", player.getX()); self.addProperty("y", player.getY()); self.addProperty("z", player.getZ());
        self.addProperty("yaw", player.getYRot()); self.addProperty("pitch", player.getXRot());
        self.addProperty("health", player.getHealth()); self.addProperty("maxHealth", player.getMaxHealth());
        self.addProperty("food", player.getFoodData().getFoodLevel());
        self.addProperty("air", player.getAirSupply());
        self.addProperty("onGround", player.onGround()); self.addProperty("inWater", player.isInWater());
        self.addProperty("onFire", player.isOnFire()); self.addProperty("sprinting", player.isSprinting());
        self.addProperty("dead", player.isDeadOrDying());
        return self;
    }

    private static JsonArray entities(Iterable<Entity> candidates, Entity self) {
        record Seen(double distance, JsonObject json) {}
        List<Seen> seen = new ArrayList<>();
        for (Entity entity : candidates) {
            if (entity == self || !entity.isAlive()) continue;
            double distance = entity.distanceTo(self);
            if (!(distance <= MAX_RADIUS)) continue;
            JsonObject json = new JsonObject();
            json.addProperty("id", entity.getId());
            json.addProperty("uuid", entity.getUUID().toString());
            json.addProperty("visible", self instanceof LivingEntity viewer && viewer.hasLineOfSight(entity));
            json.addProperty("type", String.valueOf(BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType())));
            json.addProperty("hostile", entity instanceof Enemy);
            json.addProperty("player", entity instanceof Player);
            json.addProperty("x", entity.getX()); json.addProperty("y", entity.getY()); json.addProperty("z", entity.getZ());
            json.addProperty("distance", distance);
            if (entity instanceof LivingEntity living) {
                json.addProperty("health", living.getHealth());
                json.addProperty("maxHealth", living.getMaxHealth());
            }
            seen.add(new Seen(distance, json));
        }
        seen.sort(Comparator.comparingDouble(Seen::distance));
        JsonArray array = new JsonArray();
        // Nearest first, then truncate: a cap must never hide the thing standing next to us.
        for (int index = 0; index < Math.min(seen.size(), MAX_ENTITIES); index++) array.add(seen.get(index).json());
        return array;
    }

    private static JsonObject inventory(LocalPlayer player) {
        JsonObject inventory = new JsonObject();
        var bag = player.getInventory();
        inventory.addProperty("selectedSlot", bag.getSelectedSlot());
        inventory.addProperty("size", 41);
        JsonArray items = new JsonArray();
        for (int slot = 0; slot < 36; slot++) {
            ItemStack stack = bag.getItem(slot);
            if (stack.isEmpty()) continue;
            JsonObject item = new JsonObject();
            item.addProperty("slot", slot);
            item.addProperty("item", String.valueOf(BuiltInRegistries.ITEM.getKey(stack.getItem())));
            item.addProperty("count", stack.getCount());
            if(stack.isDamageableItem()) item.addProperty("durability",stack.getMaxDamage()-stack.getDamageValue());
            items.add(item);
        }
        net.minecraft.world.entity.EquipmentSlot[] equipment={net.minecraft.world.entity.EquipmentSlot.FEET,net.minecraft.world.entity.EquipmentSlot.LEGS,net.minecraft.world.entity.EquipmentSlot.CHEST,net.minecraft.world.entity.EquipmentSlot.HEAD,net.minecraft.world.entity.EquipmentSlot.OFFHAND};
        for(int index=0;index<equipment.length;index++) {
            ItemStack stack=player.getItemBySlot(equipment[index]);if(stack.isEmpty()) continue;
            JsonObject item=new JsonObject();item.addProperty("slot",36+index);item.addProperty("equipmentSlot",equipment[index].getName());
            item.addProperty("item",String.valueOf(BuiltInRegistries.ITEM.getKey(stack.getItem())));item.addProperty("count",stack.getCount());
            if(stack.isDamageableItem()) item.addProperty("durability",stack.getMaxDamage()-stack.getDamageValue());
            items.add(item);
        }
        inventory.add("items", items);
        return inventory;
    }
}

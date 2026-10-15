package dev.windove.bridge;

import java.util.*;
import net.minecraft.client.Minecraft;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;

/**
 * Keeps what we are carrying actually usable: armour worn, and the tools we need in the hotbar.
 *
 * This exists because inventory position is not cosmetic. The safety tier only sees the hotbar,
 * so an iron sword in the main inventory is not a weapon -- observed live, the bot fought a zombie
 * with a diamond pickaxe at 6.0 dps while carrying a sword it could not reach. Armour was likewise
 * mined, crafted, carried and never worn.
 *
 * It runs on the client tick between actions, one click at a time, so it costs no model latency
 * and never fights the skill layer for the cursor.
 */
final class Loadout {
    /** Player inventory menu layout: 5-8 armour (head down), 9-35 main, 36-44 hotbar. */
    private static final int ARMOR_FIRST=5, MAIN_FIRST=9, HOTBAR_FIRST=36, HOTBAR_SIZE=9;
    private static final String[] ARMOR_SLOTS={"helmet","chestplate","leggings","boots"};
    private static final int EVERY_TICKS=20, CLICK_GAP=4;
    private int ticks, nextClickAt;
    private String last="";

    String last() { return last; }
    void reset() { ticks=0; nextClickAt=0; last=""; }

    private static String id(ItemStack stack) {
        return stack.isEmpty()?"":BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
    }
    /** Material quality, shared by tools, weapons and armour. Higher is better. */
    static int material(String item) {
        if(item.startsWith("netherite_")) return 6;
        if(item.startsWith("diamond_")) return 5;
        if(item.startsWith("iron_") || item.startsWith("turtle_")) return 4;
        if(item.startsWith("chainmail_") || item.startsWith("stone_")) return 3;
        if(item.startsWith("golden_")) return 2;
        if(item.startsWith("wooden_") || item.startsWith("leather_")) return 1;
        return 0;
    }
    /** The kit we want within reach, in the order slots are claimed for it. */
    private static String kind(String item) {
        if(item.endsWith("_pickaxe")) return "pickaxe";
        if(item.endsWith("_sword")) return "sword";
        if(item.endsWith("_axe") && !item.endsWith("_pickaxe")) return "axe";
        if(item.endsWith("_shovel")) return "shovel";
        return "";
    }
    private static final List<String> KIT=List.of("pickaxe","sword","axe","shovel");

    /**
     * One adjustment per call, or null when the kit is already right. Returns a description of
     * what it did so the operator can see why the inventory moved.
     */
    String tick(Minecraft mc) {
        if(mc.player==null || ++ticks<nextClickAt || ticks%EVERY_TICKS!=0) return null;
        var menu=mc.player.inventoryMenu;
        // Only when nothing else owns the cursor: a skill mid-craft must not have slots moved.
        if(mc.player.containerMenu!=menu || !menu.getCarried().isEmpty()) return null;
        String change=armour(mc,menu);
        if(change==null) change=hotbar(mc,menu);
        if(change!=null) {nextClickAt=ticks+CLICK_GAP;last=change;}
        return change;
    }

    /** Wear the best piece we own for each slot, taking the old one off first when it is worse. */
    private String armour(Minecraft mc,net.minecraft.world.inventory.AbstractContainerMenu menu) {
        for(int slot=ARMOR_FIRST;slot<ARMOR_FIRST+ARMOR_SLOTS.length;slot++) {
            String wanted="_"+ARMOR_SLOTS[slot-ARMOR_FIRST];
            ItemStack worn=menu.getSlot(slot).getItem();
            int wornRank=id(worn).endsWith(wanted)?material(id(worn)):-1;
            int best=-1,bestRank=wornRank;
            for(int from=MAIN_FIRST;from<HOTBAR_FIRST+HOTBAR_SIZE;from++) {
                String item=id(menu.getSlot(from).getItem());
                if(!item.endsWith(wanted) || material(item)<=bestRank) continue;
                best=from;bestRank=material(item);
            }
            if(best<0) continue;
            if(!worn.isEmpty()) {
                click(mc,menu,slot,0,ContainerInput.QUICK_MOVE);
                return "took off "+id(worn)+" for something better";
            }
            String item=id(menu.getSlot(best).getItem());
            click(mc,menu,best,0,ContainerInput.QUICK_MOVE);
            return "equipped "+item;
        }
        return null;
    }

    /**
     * Bring the best of each tool, plus something to eat, within reach. Displaces a hotbar slot
     * holding something the kit does not need, and never displaces part of the kit itself.
     */
    private String hotbar(Minecraft mc,net.minecraft.world.inventory.AbstractContainerMenu menu) {
        for(String want:KIT) {
            int best=-1,bestRank=-1;
            for(int from=MAIN_FIRST;from<HOTBAR_FIRST+HOTBAR_SIZE;from++) {
                String item=id(menu.getSlot(from).getItem());
                if(!kind(item).equals(want) || material(item)<=bestRank) continue;
                best=from;bestRank=material(item);
            }
            if(best<0 || best>=HOTBAR_FIRST) continue;    // none, or the best one is already in reach
            int target=freeHotbarSlot(menu);
            if(target<0) continue;
            String item=id(menu.getSlot(best).getItem());
            click(mc,menu,best,target,ContainerInput.SWAP);
            return "moved "+item+" to hotbar slot "+(target+1);
        }
        // Food last: it is the safety tier's eat reflex that needs it, and that only reads the hotbar.
        boolean fed=false;
        int food=-1;
        for(int from=MAIN_FIRST;from<HOTBAR_FIRST+HOTBAR_SIZE;from++) {
            ItemStack stack=menu.getSlot(from).getItem();
            if(!stack.has(DataComponents.FOOD) || id(stack).equals("rotten_flesh")) continue;
            if(from>=HOTBAR_FIRST) {fed=true;break;}
            if(food<0) food=from;
        }
        if(!fed && food>=0) {
            int target=freeHotbarSlot(menu);
            if(target>=0) {
                String item=id(menu.getSlot(food).getItem());
                click(mc,menu,food,target,ContainerInput.SWAP);
                return "moved "+item+" to hotbar slot "+(target+1);
            }
        }
        return null;
    }
    /** An empty hotbar slot, or one holding something the kit does not need. */
    private static int freeHotbarSlot(net.minecraft.world.inventory.AbstractContainerMenu menu) {
        int fallback=-1;
        for(int index=0;index<HOTBAR_SIZE;index++) {
            ItemStack stack=menu.getSlot(HOTBAR_FIRST+index).getItem();
            if(stack.isEmpty()) return index;
            String item=id(stack);
            if(fallback<0 && kind(item).isEmpty() && !stack.has(DataComponents.FOOD)) fallback=index;
        }
        return fallback;
    }
    private static void click(Minecraft mc,net.minecraft.world.inventory.AbstractContainerMenu menu,
                              int slot,int button,ContainerInput input) {
        mc.gameMode.handleContainerInput(menu.containerId,slot,button,input,mc.player);
    }
}

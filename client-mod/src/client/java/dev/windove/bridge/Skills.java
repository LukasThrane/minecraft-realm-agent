package dev.windove.bridge;

import com.google.gson.*;
import baritone.api.BaritoneAPI;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalComposite;
import baritone.api.Settings;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.world.item.Items;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.inventory.FurnaceMenu;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

final class Skills {
    private final String kind, item;
    private final JsonObject args;
    private final int baseline, count;
    private int age, stage, gridIndex, sourceSlot, waitUntil;
    private BlockPos target;
    private Object menu;
    private boolean openedMenu;
    private int inserted;
    private final BlockPos origin;
    private final List<Runnable> restoreSettings = new ArrayList<>();
    private boolean returning;
    private int returnTicks;
    private Goal returnGoal;

    Skills(Minecraft mc, JsonObject args) {
        this.args=args;kind=args.get("kind").getAsString();item=args.get("item").getAsString();
        count=args.get("count").getAsInt();baseline=count(mc,item);
        origin=mc.player.blockPosition().immutable();
        var settings=BaritoneAPI.getSettings();
        override(settings.allowBreak,true);
        override(settings.allowPlace,true);
        override(settings.allowInventory,true);
        override(settings.autoTool,true);
        override(settings.assumeExternalAutoTool,false);
        override(settings.allowDownward,false);
        override(settings.blockPlacementPenalty,Math.max(20.0,settings.blockPlacementPenalty.value));
        override(settings.acceptableThrowawayItems,List.of(Items.DIRT,Items.COBBLESTONE,Items.COBBLED_DEEPSLATE,Items.NETHERRACK).stream()
            .filter(blockItem->!kind.equals("gather") || !String.valueOf(BuiltInRegistries.ITEM.getKey(blockItem)).equals(item)).toList());
        override(settings.allowOnlyExposedOres,false);
        if(kind.equals("gather") && (item.equals("minecraft:cobblestone") || item.equals("minecraft:dirt") || item.endsWith("_log"))) {
            override(settings.minYLevelWhileMining,origin.getY()-3);
            override(settings.maxYLevelWhileMining,origin.getY()+16);
        }
    }

    private <Value> void override(Settings.Setting<Value> setting, Value value) {
        Value previous=setting.value;
        restoreSettings.add(()->setting.value=previous);
        setting.value=value;
    }

    private Goal returnArea(Minecraft mc) {
        List<Goal> goals=new ArrayList<>();
        for(BlockPos candidate:BlockPos.betweenClosed(origin.offset(-4,-1,-4),origin.offset(4,1,4))) {
            if(!mc.level.hasChunkAt(candidate)) continue;
            if(!mc.level.getBlockState(candidate).getCollisionShape(mc.level,candidate).isEmpty()) continue;
            if(!mc.level.getBlockState(candidate.above()).getCollisionShape(mc.level,candidate.above()).isEmpty()) continue;
            if(!mc.level.getBlockState(candidate.below()).isFaceSturdy(mc.level,candidate.below(),Direction.UP)) continue;
            if(!mc.level.getFluidState(candidate).isEmpty() || !mc.level.getFluidState(candidate.above()).isEmpty()) continue;
            goals.add(new GoalBlock(candidate.immutable()));
        }
        if(goals.isEmpty()) throw new IllegalStateException("return_area_unavailable: materials retained; no standing space near worksite");
        return new GoalComposite(goals.toArray(Goal[]::new));
    }

    boolean ownsMenu(Minecraft mc) {
        if(openedMenu && menu==null && mc.player!=null && (mc.player.containerMenu instanceof CraftingMenu || mc.player.containerMenu instanceof FurnaceMenu)) menu=mc.player.containerMenu;
        return openedMenu && mc.player!=null && mc.player.containerMenu==menu && (menu instanceof CraftingMenu || menu instanceof FurnaceMenu);
    }

    static String id(net.minecraft.world.item.ItemStack stack) { return String.valueOf(BuiltInRegistries.ITEM.getKey(stack.getItem())); }
    static int count(Minecraft mc, String item) {
        int total=0;
        for(int slot=0;slot<36;slot++) {
            var stack=mc.player.getInventory().getItem(slot);
            if(id(stack).equals(item)) total+=stack.getCount();
        }
        return total;
    }
    void close(Minecraft mc) {
        Observations.invalidateStations();
        var baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
        baritone.getMineProcess().cancel();
        baritone.getPathingBehavior().forceCancel();
        baritone.getInputOverrideHandler().clearAllKeys();
        for(var restore:restoreSettings) restore.run();
        restoreSettings.clear();
        if(mc.gameMode!=null) mc.gameMode.stopDestroyBlock();
        if((kind.equals("craft") || kind.equals("smelt")) && mc.player!=null && mc.player.containerMenu==menu) mc.player.closeContainer();
    }
    void click(Minecraft mc, int slot, int button, ContainerInput input) {
        mc.gameMode.handleContainerInput(mc.player.containerMenu.containerId,slot,button,input,mc.player);
        waitUntil=age+5;
    }
    boolean select(Minecraft mc, String wanted) {
        for(int slot=0;slot<36;slot++) if(id(mc.player.getInventory().getItem(slot)).equals(wanted)) {
            if(slot<9) mc.player.getInventory().setSelectedSlot(slot);
            else {
                if(mc.player.containerMenu!=mc.player.inventoryMenu) throw new IllegalStateException("Close the current container first");
                click(mc,slot,0,ContainerInput.SWAP);mc.player.getInventory().setSelectedSlot(0);
            }
            return true;
        }
        return false;
    }
    BlockHitResult hit(Minecraft mc, BlockPos pos) {
        Vec3 eye=mc.player.getEyePosition(), center=Vec3.atCenterOf(pos);
        Vec3 delta=center.subtract(eye);
        mc.player.setYRot((float)(Math.toDegrees(Math.atan2(delta.z,delta.x))-90));
        mc.player.setXRot((float)-Math.toDegrees(Math.atan2(delta.y,Math.hypot(delta.x,delta.z))));
        var result=mc.level.clip(new ClipContext(eye,center,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,mc.player));
        return result.getType()==HitResult.Type.BLOCK && result.getBlockPos().equals(pos) && eye.distanceTo(result.getLocation())<=4.3?result:null;
    }
    BlockPos find(Minecraft mc, String wanted) {
        BlockPos found=null;double distance=Double.MAX_VALUE;
        for(BlockPos pos:BlockPos.betweenClosed(mc.player.blockPosition().offset(-24,-12,-24),mc.player.blockPosition().offset(24,12,24))) {
            if(!mc.level.hasChunkAt(pos)) continue;
            String block=String.valueOf(BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(pos).getBlock()));
            boolean matches=block.equals(wanted);
            if(kind.equals("gather")) {
                matches=false;
                for(var entry:args.getAsJsonArray("blocks")) if(entry.getAsString().equals(block)) matches=true;
            }
            double candidate=pos.distSqr(mc.player.blockPosition());
            if(matches && candidate<distance) {found=pos.immutable();distance=candidate;}
        }
        return found;
    }
    String tick(Minecraft mc) {
        age++;
        if(age<waitUntil) return null;
        if(kind.equals("craft")) return craft(mc);
        if(kind.equals("smelt")) return smelt(mc);
        if(kind.equals("deploy_station")) return deploy(mc);
        if(!kind.equals("gather")) throw new IllegalStateException("Unsupported skill: "+kind);
        var baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
        if(returning) {
            boolean home=returnGoal.isInGoal(mc.player.blockPosition()) && mc.player.onGround();
            returnTicks=home?returnTicks+1:0;
            if(returnTicks>=5) {
                if(count(mc,item)>=baseline+count) return "Inventory gain and return to worksite verified: "+item;
                throw new IllegalStateException("return_inventory_shortfall: acquired materials no longer present");
            } else if(!baritone.getCustomGoalProcess().isActive() && !home) {
                throw new IllegalStateException("return_path_failed: materials acquired but worksite not reached");
            }
            return null;
        }
        if(count(mc,item)>=baseline+count) {
            baritone.getMineProcess().cancel();
            baritone.getPathingBehavior().forceCancel();
            returnGoal=returnArea(mc);
            baritone.getCustomGoalProcess().setGoalAndPath(returnGoal);
            returning=true;waitUntil=age+5;return null;
        }
        if(args.has("tool") && !args.get("tool").isJsonNull()) {
            String tool=args.get("tool").getAsString();
            boolean inHotbar=false;
            for(int slot=0;slot<9;slot++) if(id(mc.player.getInventory().getItem(slot)).equals(tool)) inHotbar=true;
            if(!inHotbar) {
                if(!select(mc,tool)) throw new IllegalStateException("tool_required: missing or broken "+tool);
                return null;
            }
        }
        if(stage==0) {
            String[] blocks=new String[args.getAsJsonArray("blocks").size()];
            for(int index=0;index<blocks.length;index++) blocks[index]=args.getAsJsonArray("blocks").get(index).getAsString();
            if(blocks.length==0) throw new IllegalStateException("no_source: empty mining targets");
            baritone.getMineProcess().mineByName(0,blocks);
            stage=1;waitUntil=age+10;return null;
        }
        if(!baritone.getMineProcess().isActive()) throw new IllegalStateException("mining_path_failed: no accessible targets or pickup route");
        return null;
    }
    String deploy(Minecraft mc) {
        if(target!=null) {
            if(String.valueOf(BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(target).getBlock())).equals(item)) return "Station placement observed";
            throw new IllegalStateException("placement_not_observed");
        }
        BlockPos existing=find(mc,item);
        if(existing!=null && hit(mc,existing)!=null) return "Existing reachable station observed";
        if(stage==0) {if(!select(mc,item)) throw new IllegalStateException("station_item_missing");stage=1;waitUntil=age+5;return null;}
        for(BlockPos candidate:BlockPos.betweenClosed(mc.player.blockPosition().offset(-3,-2,-3),mc.player.blockPosition().offset(3,2,3))) {
            BlockPos place=candidate.immutable(), support=place.below();
            if(place.equals(mc.player.blockPosition()) || place.equals(mc.player.blockPosition().above())) continue;
            if(!mc.level.getBlockState(place).isAir()) continue;
            var hit=hit(mc,support);
            if(hit==null || hit.getDirection()!=Direction.UP) continue;
            mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit);
            target=place;waitUntil=age+15;return null;
        }
        throw new IllegalStateException("no_placement_surface: needs reachable clear ground");
    }
    String craft(Minecraft mc) {
        if(stage==0) {
            if(args.get("station").getAsString().equals("crafting_table")) {
                target=find(mc,"minecraft:crafting_table");
                if(target==null) throw new IllegalStateException("station_missing");
                var hit=hit(mc,target);
                if(hit==null) {
                    BaritoneAPI.getProvider().getPrimaryBaritone().getCustomGoalProcess().setGoalAndPath(new GoalNear(target,2));
                    waitUntil=age+20;return null;
                }
                BaritoneAPI.getProvider().getPrimaryBaritone().getPathingBehavior().forceCancel();
                mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit);
                openedMenu=true;stage=1;waitUntil=age+10;return null;
            }
            stage=1;
        }
        if(stage==1) {
            menu=mc.player.containerMenu;
            if(!(menu instanceof InventoryMenu) && !(menu instanceof CraftingMenu)) throw new IllegalStateException("wrong_menu");
            if(openedMenu && !(menu instanceof CraftingMenu)) throw new IllegalStateException("station_menu_not_opened");
            int size=menu instanceof CraftingMenu?9:4;
            if(!mc.player.containerMenu.getCarried().isEmpty()) throw new IllegalStateException("cursor_not_empty");
            for(int slot=1;slot<=size;slot++) if(!mc.player.containerMenu.getSlot(slot).getItem().isEmpty()) throw new IllegalStateException("crafting_grid_not_empty");
            stage=2;
        }
        if(mc.player.containerMenu!=menu) throw new IllegalStateException("menu_changed");
        int width=menu instanceof CraftingMenu?3:2;
        var grid=args.getAsJsonArray("grid");
        if(stage==2) {
            while(gridIndex<grid.size() && grid.get(gridIndex).getAsString().isEmpty()) gridIndex++;
            if(gridIndex==grid.size()) {stage=5;waitUntil=age+10;return null;}
            String ingredient=grid.get(gridIndex).getAsString();
            int start=width==3?10:9, end=start+36;
            sourceSlot=-1;
            for(int slot=start;slot<end;slot++) if(id(mc.player.containerMenu.getSlot(slot).getItem()).equals(ingredient)) {sourceSlot=slot;break;}
            if(sourceSlot<0) throw new IllegalStateException("ingredient_missing: "+ingredient);
            click(mc,sourceSlot,0,ContainerInput.PICKUP);stage=3;return null;
        }
        if(stage==3) {
            if(!id(mc.player.containerMenu.getCarried()).equals(grid.get(gridIndex).getAsString())) throw new IllegalStateException("cursor_ack_mismatch");
            int recipeWidth=args.get("width").getAsInt();
            click(mc,1+(gridIndex/recipeWidth)*width+gridIndex%recipeWidth,1,ContainerInput.PICKUP);stage=4;return null;
        }
        if(stage==4) {
            if(!mc.player.containerMenu.getCarried().isEmpty()) click(mc,sourceSlot,0,ContainerInput.PICKUP);
            gridIndex++;stage=2;return null;
        }
        if(stage==5) {
            var output=mc.player.containerMenu.getSlot(0).getItem();
            if(!id(output).equals(item) || output.getCount()!=count) throw new IllegalStateException("recipe_output_mismatch");
            click(mc,0,0,ContainerInput.QUICK_MOVE);stage=6;waitUntil=age+15;return null;
        }
        if(count(mc,item)<baseline+count) throw new IllegalStateException("output_not_observed_or_inventory_full");
        return "Crafted output observed in inventory: "+item;
    }
    String smelt(Minecraft mc) {
        if(stage==0) {
            target=find(mc,"minecraft:furnace");
            if(target==null) throw new IllegalStateException("furnace_missing");
            var hit=hit(mc,target);
            if(hit==null) {
                BaritoneAPI.getProvider().getPrimaryBaritone().getCustomGoalProcess().setGoalAndPath(new GoalNear(target,2));
                waitUntil=age+20;return null;
            }
            BaritoneAPI.getProvider().getPrimaryBaritone().getPathingBehavior().forceCancel();
            mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit);
            openedMenu=true;stage=1;waitUntil=age+10;return null;
        }
        if(stage==1) {
            menu=mc.player.containerMenu;
            if(!(menu instanceof FurnaceMenu)) throw new IllegalStateException("furnace_menu_not_opened");
            if(!mc.player.containerMenu.getCarried().isEmpty()) throw new IllegalStateException("cursor_not_empty");
            for(int slot=0;slot<3;slot++) if(!mc.player.containerMenu.getSlot(slot).getItem().isEmpty()) throw new IllegalStateException("furnace_not_empty: existing contents retained");
            stage=2;
        }
        if(mc.player.containerMenu!=menu) throw new IllegalStateException("menu_changed");
        if(stage==2 || stage==5) {
            String wanted=stage==2?"minecraft:raw_iron":"minecraft:coal";
            sourceSlot=-1;
            for(int slot=3;slot<39;slot++) {
                var stack=mc.player.containerMenu.getSlot(slot).getItem();
                if(id(stack).equals(wanted) && stack.getCount()>=(stage==2?count:1)) {sourceSlot=slot;break;}
            }
            if(sourceSlot<0) throw new IllegalStateException("ingredient_missing_or_split_stack: "+wanted);
            click(mc,sourceSlot,0,ContainerInput.PICKUP);inserted=0;stage++;return null;
        }
        if(stage==3 || stage==6) {
            String wanted=stage==3?"minecraft:raw_iron":"minecraft:coal";
            if(!id(mc.player.containerMenu.getCarried()).equals(wanted)) throw new IllegalStateException("cursor_ack_mismatch");
            click(mc,stage==3?0:1,1,ContainerInput.PICKUP);
            if(++inserted>=(stage==3?count:1)) stage++;
            return null;
        }
        if(stage==4 || stage==7) {
            if(!mc.player.containerMenu.getCarried().isEmpty()) click(mc,sourceSlot,0,ContainerInput.PICKUP);
            stage++;return null;
        }
        if(count(mc,item)>=baseline+count) return "Smelted ingots observed in inventory";
        var output=mc.player.containerMenu.getSlot(2).getItem();
        if(!output.isEmpty()) {
            if(!id(output).equals(item)) throw new IllegalStateException("smelting_output_mismatch");
            click(mc,2,0,ContainerInput.QUICK_MOVE);
        }
        return null;
    }
}

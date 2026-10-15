package dev.realmagent.bridge;

import com.google.gson.*;
import baritone.api.BaritoneAPI;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalComposite;
import baritone.api.Settings;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.world.item.Item;
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
    private int initialFood, shaftStep;
    private int age, stage, gridIndex, sourceSlot, waitUntil;
    private BlockPos target;
    private Object menu;
    private boolean openedMenu;
    private int inserted, needInput, needFuel, fuelSlot;
    private final BlockPos origin;
    private final List<Runnable> restoreSettings = new ArrayList<>();
    private boolean returning;
    private int returnTicks, returnAttempts, approachAttempts;
    private Goal returnGoal;
    /** Bounded retries: a route that keeps failing is a typed failure, not an infinite wait. */
    private static final int RETURN_ATTEMPTS = 3, APPROACH_ATTEMPTS = 3;
    /**
     * What we keep back rather than leaving behind us as scaffolding, by block.
     *
     * Baritone pillars and bridges with whatever it is allowed to throw away, and cobblestone is
     * the first thing every plan needs: it spent the three cobble it had just mined on climbing
     * out of the hole and then went back to mine them again. Dirt and netherrack are not an
     * ingredient in anything we plan at this tier, so a block of dirt to hop back up is free; the
     * cobble reserve is a furnace's worth, the largest single thing an early plan buys with it.
     *
     * Refusing to place anything at all was worse than either. With the list empty Baritone
     * cannot pillar or bridge, so every hole it digs has to be mined back out as a staircase --
     * which is the unlimited mining this was supposed to stop.
     */
    private static final int SPARE_COBBLE = 8;
    private static final java.util.Map<Item,Integer> SCAFFOLD = java.util.Map.of(
        Items.DIRT,0, Items.NETHERRACK,0, Items.COBBLESTONE,SPARE_COBBLE, Items.COBBLED_DEEPSLATE,SPARE_COBBLE);
    /**
     * What we have left cooking, by output item. Furnace contents are not synced to the client
     * unless its menu is open, so this is what we put in and have not taken out -- reconciled
     * against the real slots every time a smelt opens the furnace, and cleared with the session.
     * Without it the agent replans from inventory alone and concludes it must mine the ore again.
     */
    private static final java.util.Map<String,Integer> PENDING = new java.util.concurrent.ConcurrentHashMap<>();
    static java.util.Map<String,Integer> pending() { return PENDING; }
    static void clearPending() { PENDING.clear(); }

    Skills(Minecraft mc, JsonObject args) {
        this.args=args;kind=args.get("kind").getAsString();item=args.get("item").getAsString();
        count=args.get("count").getAsInt();baseline=count(mc,item);initialFood=mc.player.getFoodData().getFoodLevel();
        origin=mc.player.blockPosition().immutable();
        var settings=BaritoneAPI.getSettings();
        override(settings.allowBreak,!kind.equals("shaft"));
        override(settings.allowPlace,!kind.equals("shaft"));
        override(settings.allowInventory,true);
        override(settings.autoTool,true);
        override(settings.assumeExternalAutoTool,false);
        override(settings.allowDownward,false);
        override(settings.allowWalkOnMagmaBlocks,false);
        override(settings.assumeWalkOnLava,false);
        override(settings.allowParkour,false);
        override(settings.allowParkourPlace,false);
        var avoid=new ArrayList<>(settings.blocksToAvoid.value);
        for(var block:List.of(net.minecraft.world.level.block.Blocks.LAVA,net.minecraft.world.level.block.Blocks.FIRE,net.minecraft.world.level.block.Blocks.SOUL_FIRE,net.minecraft.world.level.block.Blocks.MAGMA_BLOCK,net.minecraft.world.level.block.Blocks.CAMPFIRE,net.minecraft.world.level.block.Blocks.SOUL_CAMPFIRE)) if(!avoid.contains(block)) avoid.add(block);
        override(settings.blocksToAvoid,avoid);
        override(settings.blockPlacementPenalty,Math.max(20.0,settings.blockPlacementPenalty.value));
        override(settings.acceptableThrowawayItems,scaffolding(mc));
        // Look where we are going. Baritone's default sends rotations to the server without moving
        // the camera, so from a spectator's seat the character sprints backwards with its eyes
        // locked somewhere irrelevant. Turning free-look off makes the head follow the path and
        // the block being mined; smoothing keeps it from snapping.
        override(settings.freeLook,false);
        override(settings.blockFreeLook,false);
        override(settings.smoothLook,true);
        override(settings.randomLooking,0.0d);
        if(kind.equals("gather") && (item.equals("minecraft:cobblestone") || item.equals("minecraft:dirt") || item.endsWith("_log"))) {
            // Baritone measures this floor from the bottom of the world, not from the worksite:
            // `minYLevelWhileMining + dimensionType().minY()`. Passing a raw Y meant the intended
            // twelve blocks below the surface was really y=-13, and the agent took it -- seventy
            // blocks of tunnel to reach stone it was standing four blocks above.
            int floor=origin.getY()-(item.endsWith("_log")?3:12);
            override(settings.minYLevelWhileMining,floor-mc.level.dimensionType().minY());
            // The ceiling, unlike the floor, Baritone reads as a plain Y.
            override(settings.maxYLevelWhileMining,origin.getY()+16);
        }
        // Prefer what is already near the surface over whichever buried block happens to be
        // closest in a straight line. Observed live: it walked past a hillside of stone, and past
        // the stone under its own feet, to tunnel after something further away.
        int reach=kind.equals("gather")?exposedReach(mc,args):0;
        override(settings.allowOnlyExposedOres,reach>0);
        if(reach>0) override(settings.allowOnlyExposedOresDistance,reach);
    }

    /**
     * The smallest distance from open air at which there is enough of the target around us, or 0
     * if there is not enough of it anywhere near the surface.
     *
     * Baritone's filter is a manhattan radius, so this is the number to hand it: at 1 it keeps to
     * outcrops and cave walls, at 3 or 4 it will also take the stone under a few blocks of dirt --
     * a short hole down, which is what a player does -- while ore that is genuinely buried still
     * falls through to unrestricted tunnelling. We probe along the six axes only; every block that
     * finds air that way is inside the ball Baritone checks, so anything we count, it accepts.
     */
    private static final int EXPOSED_ENOUGH=12, EXPOSED_RADIUS=16, EXPOSED_HEIGHT=6, EXPOSED_REACH=4;
    private static int exposedReach(Minecraft mc, JsonObject args) {
        if(mc.level==null || mc.player==null || !args.has("blocks")) return 0;
        java.util.Set<String> wanted=new java.util.HashSet<>();
        for(var entry:args.getAsJsonArray("blocks")) wanted.add(entry.getAsString());
        if(wanted.isEmpty()) return 0;
        BlockPos at=mc.player.blockPosition();
        int[] found=new int[EXPOSED_REACH+1];
        for(BlockPos position:BlockPos.betweenClosed(at.offset(-EXPOSED_RADIUS,-EXPOSED_HEIGHT,-EXPOSED_RADIUS),
                                                     at.offset(EXPOSED_RADIUS,EXPOSED_HEIGHT,EXPOSED_RADIUS))) {
            if(!mc.level.hasChunkAt(position)) continue;
            if(!wanted.contains(String.valueOf(BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(position).getBlock())))) continue;
            int distance=airDistance(mc,position);
            if(distance>0) found[distance]++;
            if(found[1]>=EXPOSED_ENOUGH) return 1;
        }
        int running=0;
        for(int distance=1;distance<=EXPOSED_REACH;distance++) {
            running+=found[distance];
            if(running>=EXPOSED_ENOUGH) return distance;
        }
        return 0;
    }
    private static int airDistance(Minecraft mc, BlockPos position) {
        for(int distance=1;distance<=EXPOSED_REACH;distance++) for(Direction side:Direction.values()) {
            BlockPos probe=position.relative(side,distance);
            if(mc.level.hasChunkAt(probe) && mc.level.getBlockState(probe).isAir()) return distance;
        }
        return 0;
    }
    /** Blocks we can spare for scaffolding right now: over the reserve, and never what we came for. */
    private List<Item> scaffolding(Minecraft mc) {
        List<Item> spare=new ArrayList<>();
        for(var reserved:SCAFFOLD.entrySet()) {
            String id=String.valueOf(BuiltInRegistries.ITEM.getKey(reserved.getKey()));
            if(kind.equals("gather") && id.equals(item)) continue;
            int minimum=reserved.getValue();
            if(args.has("reserves") && args.getAsJsonObject("reserves").has(id)) minimum=Math.max(minimum,args.getAsJsonObject("reserves").get(id).getAsInt());
            if(count(mc,id)>minimum) spare.add(reserved.getKey());
        }
        return spare;
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
        mc.options.keyUse.setDown(false);
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
    /** A station we own: remembered first, then whatever the local scan turns up. */
    BlockPos station(Minecraft mc, String kind) {
        Stations.refresh(mc);
        for(BlockPos remembered:Stations.nearest(mc,kind)) return remembered;
        return find(mc,"minecraft:"+kind);
    }
    /**
     * Get within reach of a station, walking to a remembered one if we are no longer beside it.
     *
     * Returns null while still travelling. A route that keeps failing ends as `station_unreachable`
     * rather than spinning until the action deadline, because "we own a table but cannot get to it"
     * is a different problem from owning none, and only the typed form can be acted on later.
     */
    BlockPos approach(Minecraft mc, String kind) {
        if(target==null) target=station(mc,kind);
        if(target==null) throw new IllegalStateException("station_missing: no known "+kind);
        var pathing=BaritoneAPI.getProvider().getPrimaryBaritone();
        if(hit(mc,target)!=null) {pathing.getPathingBehavior().forceCancel();Stations.record(mc,target,kind);return target;}
        if(pathing.getCustomGoalProcess().isActive()) {waitUntil=age+10;return null;}
        if(++approachAttempts>APPROACH_ATTEMPTS) {
            Stations.unreachable(target);
            throw new IllegalStateException("station_unreachable: no route to "+kind+" at "+target.toShortString()+"; forgotten, place another");
        }
        pathing.getCustomGoalProcess().setGoalAndPath(new GoalNear(target,2));
        waitUntil=age+20;return null;
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
        // The reserve is a floor, and Baritone spends without consulting us, so re-check it as we
        // go: a block that has fallen to its reserve stops being scaffolding mid-job.
        BaritoneAPI.getSettings().acceptableThrowawayItems.value=scaffolding(mc);
        if((kind.equals("gather") || kind.equals("shaft")) && approachingHazard(mc)) throw new IllegalStateException("hazard_ahead: movement would approach a contact hazard; route review required");
        if(age<waitUntil) return null;
        if(kind.equals("eat")) return eat(mc);
        if(kind.equals("equip")) return equip(mc);
        if(kind.equals("gather") || kind.equals("shaft")) checkLimits(mc);
        if(kind.equals("shaft")) return shaft(mc);
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
            }
            if(!baritone.getCustomGoalProcess().isActive() && !home) {
                if(++returnAttempts<=RETURN_ATTEMPTS) {
                    try { returnGoal=returnArea(mc); } catch(RuntimeException unavailable) { return concludeGather(mc,unavailable.getMessage()); }
                    baritone.getCustomGoalProcess().setGoalAndPath(returnGoal);
                    waitUntil=age+10;return null;
                }
                return concludeGather(mc,"no route back to the worksite");
            }
            return null;
        }
        if(count(mc,item)>=baseline+count) {
            baritone.getMineProcess().cancel();
            baritone.getPathingBehavior().forceCancel();
            if(args.has("returnToOrigin") && !args.get("returnToOrigin").getAsBoolean()) return "Inventory gain verified: "+item+"; remaining at collection site";
            try { returnGoal=returnArea(mc); } catch(RuntimeException unavailable) { return concludeGather(mc,unavailable.getMessage()); }
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
    static boolean approachingHazard(Minecraft mc) {
        var box=mc.player.getBoundingBox();var velocity=mc.player.getDeltaMovement();
        return ContactHazards.projected((x,y,z)->{
            BlockPos at=new BlockPos(x,y,z);
            if(!mc.level.hasChunkAt(at)) return true;
            var block=mc.level.getBlockState(at).getBlock();
            return mc.level.getFluidState(at).is(net.minecraft.tags.FluidTags.LAVA)
                || block==net.minecraft.world.level.block.Blocks.FIRE || block==net.minecraft.world.level.block.Blocks.SOUL_FIRE
                || block==net.minecraft.world.level.block.Blocks.MAGMA_BLOCK || block==net.minecraft.world.level.block.Blocks.CAMPFIRE
                || block==net.minecraft.world.level.block.Blocks.SOUL_CAMPFIRE;
        },new GroundSafety.Box(box.minX,box.minY,box.minZ,box.maxX,box.maxY,box.maxZ),velocity.x,Math.min(0,velocity.y),velocity.z);
    }
    JsonObject progress(Minecraft mc) {
        JsonObject out=new JsonObject();out.addProperty("kind",kind);out.addProperty("item",item);
        out.addProperty("target",count);out.addProperty("collected",Math.max(0,count(mc,item)-baseline));
        out.addProperty("phase",returning?"returning":kind.equals("gather")?"gathering":kind);
        out.addProperty("elapsedTicks",age);out.addProperty("shaftSteps",shaftStep);
        out.addProperty("food",mc.player.getFoodData().getFoodLevel());out.addProperty("health",mc.player.getHealth());
        var held=mc.player.getMainHandItem();
        if(held.isDamageableItem()) out.addProperty("heldDurability",held.getMaxDamage()-held.getDamageValue());
        return out;
    }
    void checkLimits(Minecraft mc) {
        if(args.has("minHealth") && mc.player.getHealth()<args.get("minHealth").getAsDouble()) throw new IllegalStateException("expedition_limit: health floor reached");
        if(args.has("minFood") && mc.player.getFoodData().getFoodLevel()<args.get("minFood").getAsInt()) throw new IllegalStateException("expedition_limit: food floor reached; prepare before continuing");
        var held=mc.player.getMainHandItem();
        if(args.has("minDurability") && held.isDamageableItem() && held.getMaxDamage()-held.getDamageValue()<args.get("minDurability").getAsInt()) throw new IllegalStateException("expedition_limit: tool durability floor reached");
        if(age%20==0) {
            boolean room=false;
            for(int slot=0;slot<36;slot++) {var stack=mc.player.getInventory().getItem(slot);if(stack.isEmpty() || id(stack).equals(item) && stack.getCount()<stack.getMaxStackSize()) room=true;}
            if(!room) throw new IllegalStateException("expedition_limit: inventory full");
        }
    }
    String eat(Minecraft mc) {
        int food=mc.player.getFoodData().getFoodLevel(), targetFood=args.get("targetFood").getAsInt();
        if(food>=targetFood) {mc.options.keyUse.setDown(false);return food>initialFood?"Eating verified: food increased to "+food:"Food target already satisfied: "+food;}
        int slot=Reflexes.foodSlot(mc);
        if(slot<0) throw new IllegalStateException("no_usable_food: no suitable food in inventory");
        if(slot>=9) {select(mc,id(mc.player.getInventory().getItem(slot)));waitUntil=age+5;return null;}
        mc.player.getInventory().setSelectedSlot(slot);mc.options.keyUse.setDown(true);return null;
    }
    String equip(Minecraft mc) {
        String[] suffixes={"_helmet","_chestplate","_leggings","_boots"};
        for(int i=0;i<suffixes.length;i++) if(item.endsWith(suffixes[i])) {
            int slot=5+i;
            if(id(mc.player.inventoryMenu.getSlot(slot).getItem()).equals(item)) return "Equipment observed worn: "+item;
            if(mc.player.containerMenu!=mc.player.inventoryMenu || !mc.player.containerMenu.getCarried().isEmpty()) throw new IllegalStateException("inventory_unavailable");
            if(!mc.player.inventoryMenu.getSlot(slot).getItem().isEmpty()) {click(mc,slot,0,ContainerInput.QUICK_MOVE);return null;}
            for(int from=9;from<45;from++) if(id(mc.player.inventoryMenu.getSlot(from).getItem()).equals(item)) {click(mc,from,0,ContainerInput.QUICK_MOVE);return null;}
            throw new IllegalStateException("equipment_missing: "+item);
        }
        if(id(mc.player.getMainHandItem()).equals(item)) return "Equipment observed selected: "+item;
        if(!select(mc,item)) throw new IllegalStateException("equipment_missing: "+item);
        waitUntil=age+5;return null;
    }
    /** A fixed, walkable staircase. Each tread is checked before carving or walking. */
    String shaft(Minecraft mc) {
        if(shaftStep>=count) return "Staircase verified: "+count+" reusable steps with lighting";
        Direction direction=switch(args.get("direction").getAsString()) {case "north"->Direction.NORTH;case "south"->Direction.SOUTH;case "east"->Direction.EAST;default->Direction.WEST;};
        BlockPos next=origin.relative(direction,shaftStep+1).below(shaftStep+1);
        if(!mc.level.hasChunkAt(next) || next.getY()<=mc.level.getMinY()+1) throw new IllegalStateException("shaft_limit: unloaded terrain or world floor");
        if(mc.level.getBlockState(next.below()).getCollisionShape(mc.level,next.below()).isEmpty()) throw new IllegalStateException("shaft_unsafe: unsupported next tread");
        for(int height=0;height<3;height++) {
            BlockPos block=next.above(height);
            for(Direction face:Direction.values()) if(!mc.level.getFluidState(block.relative(face)).isEmpty()) throw new IllegalStateException("shaft_unsafe: fluid beside next step");
            if(!mc.level.getFluidState(block).isEmpty()) throw new IllegalStateException("shaft_unsafe: fluid in next step");
        }
        String pick=null;
        for(int slot=0;slot<36;slot++) {var stack=mc.player.getInventory().getItem(slot);if(id(stack).endsWith("_pickaxe") && stack.getMaxDamage()-stack.getDamageValue()>10) {pick=id(stack);break;}}
        if(pick==null) throw new IllegalStateException("tool_required: staircase needs a usable pickaxe");
        var baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
        if(stage==0) {
            if(count(mc,"minecraft:torch")<1) throw new IllegalStateException("torch_required: staircase needs torches");
            for(int height=2;height>=0;height--) {
                BlockPos block=next.above(height);
                if(mc.level.getBlockState(block).isAir()) continue;
                if(mc.level.getBlockState(block).getDestroySpeed(mc.level,block)<0) throw new IllegalStateException("shaft_blocked: unbreakable block");
                if(!id(mc.player.getMainHandItem()).equals(pick)) {select(mc,pick);return null;}
                var hit=hit(mc,block);if(hit==null) throw new IllegalStateException("shaft_blocked: next step out of reach");
                baritone.getPathingBehavior().forceCancel();
                mc.gameMode.continueDestroyBlock(block,hit.getDirection());return null;
            }
            mc.gameMode.stopDestroyBlock();
            baritone.getCustomGoalProcess().setGoalAndPath(new GoalBlock(next));stage=1;return null;
        }
        if(stage==1) {
            if(!mc.player.blockPosition().equals(next) || !mc.player.onGround()) {
                if(!baritone.getCustomGoalProcess().isActive()) throw new IllegalStateException("shaft_path_failed: cannot walk onto next tread");
                return null;
            }
            baritone.getPathingBehavior().forceCancel();stage=2;
        }
        if((shaftStep+1)%args.get("torchEvery").getAsInt()==0 || shaftStep==count-1) {
            BlockPos previous=origin.relative(direction,shaftStep).below(shaftStep);
            if(!String.valueOf(BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(previous).getBlock())).equals("minecraft:torch")) {
                if(stage==3) throw new IllegalStateException("torch_placement_not_observed");
                if(!id(mc.player.getMainHandItem()).equals("minecraft:torch")) {if(!select(mc,"minecraft:torch")) throw new IllegalStateException("torch_required");return null;}
                var hit=hit(mc,previous.below());if(hit==null) throw new IllegalStateException("torch_surface_unreachable");
                mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit);stage=3;waitUntil=age+10;return null;
            }
        }
        shaftStep++;stage=0;return null;
    }
    /**
     * The trip home is a convenience, not the outcome.
     *
     * Returning exists so the next step still finds the stations we left behind, and stations are
     * now remembered by position rather than by proximity, so a failed walk back no longer costs
     * us anything we cannot recover by walking there again. Failing the whole multi-step goal over
     * it threw away materials already in hand and made the operator retype the command to make the
     * identical plan one step further, which is the one outcome the evidence never justified.
     */
    String concludeGather(Minecraft mc, String why) {
        if(count(mc,item)<baseline+count) throw new IllegalStateException("return_inventory_shortfall: acquired materials no longer present");
        return "Inventory gain verified: "+item+" (return to worksite incomplete: "+why+")";
    }
    String deploy(Minecraft mc) {
        String kind=item.replace("minecraft:","");
        if(target!=null) {
            if(String.valueOf(BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(target).getBlock())).equals(item)) {
                // Record it where it stands, so walking away is not the same as losing it.
                Stations.record(mc,target,kind);
                return "Station placement observed";
            }
            throw new IllegalStateException("placement_not_observed");
        }
        BlockPos existing=find(mc,item);
        if(existing!=null && hit(mc,existing)!=null) {Stations.record(mc,existing,kind);return "Existing reachable station observed";}
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
                if(approach(mc,"crafting_table")==null) return null;
                mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit(mc,target));
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
    /**
     * Output to the item that smelts into it. Only what this baseline can actually plan for, and
     * charcoal is handled separately because any log will do.
     */
    private static final java.util.Map<String,String> SMELTS=java.util.Map.ofEntries(
        java.util.Map.entry("minecraft:iron_ingot","minecraft:raw_iron"),
        java.util.Map.entry("minecraft:gold_ingot","minecraft:raw_gold"),
        java.util.Map.entry("minecraft:copper_ingot","minecraft:raw_copper"),
        java.util.Map.entry("minecraft:glass","minecraft:sand"),
        java.util.Map.entry("minecraft:stone","minecraft:cobblestone"),
        java.util.Map.entry("minecraft:smooth_stone","minecraft:stone"),
        java.util.Map.entry("minecraft:cooked_beef","minecraft:beef"),
        java.util.Map.entry("minecraft:cooked_porkchop","minecraft:porkchop"),
        java.util.Map.entry("minecraft:cooked_chicken","minecraft:chicken"),
        java.util.Map.entry("minecraft:cooked_mutton","minecraft:mutton"),
        java.util.Map.entry("minecraft:cooked_cod","minecraft:cod"),
        java.util.Map.entry("minecraft:cooked_salmon","minecraft:salmon"),
        java.util.Map.entry("minecraft:baked_potato","minecraft:potato"));
    private boolean isInput(String id) {
        if(item.equals("minecraft:charcoal")) return id.endsWith("_log") || id.endsWith("_wood");
        return id.equals(SMELTS.get(item));
    }
    private String inputName() {
        return item.equals("minecraft:charcoal")?"any log":String.valueOf(SMELTS.get(item));
    }
    /**
     * How many items one of this fuel smelts. Coal is not the only thing that burns, and treating
     * it as the only fuel stalled a smelt that had a stack of logs in hand.
     */
    static double fuelValue(String id) {
        return switch(id) {
            case "minecraft:coal","minecraft:charcoal" -> 8;
            case "minecraft:coal_block" -> 80;
            case "minecraft:dried_kelp_block" -> 20;
            case "minecraft:blaze_rod" -> 12;
            case "minecraft:bamboo" -> 0.25;
            case "minecraft:stick" -> 0.5;
            default -> id.endsWith("_log") || id.endsWith("_wood") || id.endsWith("_planks")
                || id.endsWith("_slab") || id.endsWith("_stairs") || id.endsWith("_fence") ? 1.5 : 0;
        };
    }
    /** Prefer fuel that is only fuel; wood is usually wanted for something else. */
    private static int fuelRank(String id) {
        double value=fuelValue(id);
        if(value<=0) return 0;
        return id.equals("minecraft:coal") || id.equals("minecraft:charcoal") ? 3 : value>=8 ? 2 : 1;
    }
    String smelt(Minecraft mc) {
        if(stage==0) {
            if(approach(mc,"furnace")==null) return null;
            mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit(mc,target));
            openedMenu=true;stage=1;waitUntil=age+10;return null;
        }
        if(stage==1) {
            menu=mc.player.containerMenu;
            if(!(menu instanceof FurnaceMenu)) throw new IllegalStateException("furnace_menu_not_opened");
            if(!mc.player.containerMenu.getCarried().isEmpty()) throw new IllegalStateException("cursor_not_empty");
            if(SMELTS.get(item)==null && !item.equals("minecraft:charcoal")) throw new IllegalStateException("unsupported_smelt_output: "+item);
            stage=2;
        }
        if(mc.player.containerMenu!=menu) throw new IllegalStateException("menu_changed");
        var input=mc.player.containerMenu.getSlot(0).getItem();
        var burning=mc.player.containerMenu.getSlot(1).getItem();
        var output=mc.player.containerMenu.getSlot(2).getItem();
        if(stage==2) {
            // Resume rather than refuse. A furnace we already loaded is progress, not an obstacle:
            // throwing on any existing contents stranded the ore we put in on the previous attempt
            // and made the agent believe it still had to mine it.
            if(!output.isEmpty()) {
                if(!id(output).equals(item)) throw new IllegalStateException("furnace_holds_other_output: "+id(output));
                take(mc,output.getCount());return null;
            }
            if(count(mc,item)>=baseline+count) return "Smelted output observed in inventory: "+item;
            if(!input.isEmpty() && !isInput(id(input))) throw new IllegalStateException("furnace_busy_with: "+id(input));
            int pending=input.isEmpty()?0:input.getCount(), produced=count(mc,item)-baseline;
            // The open menu is the authority; correct any drift in the remembered figure.
            if(pending>0) PENDING.put(item,pending); else PENDING.remove(item);
            needInput=Math.max(0,count-pending-produced);
            sourceSlot=-1;
            int available=0;
            for(int slot=3;slot<39;slot++) {
                var stack=mc.player.containerMenu.getSlot(slot).getItem();
                if(stack.isEmpty() || !isInput(id(stack))) continue;
                if(sourceSlot<0 || stack.getCount()>available) {sourceSlot=slot;available=stack.getCount();}
            }
            needInput=Math.min(needInput,available);
            if(needInput==0 && pending==0) throw new IllegalStateException("ingredient_missing: "+inputName());
            // Fuel already in the slot, plus whatever is burning right now, covers part of the batch.
            double remaining=pending+needInput;
            double covered=(burning.isEmpty()?0:fuelValue(id(burning))*burning.getCount())+(lit(mc)?1:0);
            fuelSlot=-1;needFuel=0;
            if(covered<remaining) {
                int best=0;double bestValue=0;
                for(int slot=3;slot<39;slot++) {
                    var stack=mc.player.containerMenu.getSlot(slot).getItem();
                    if(stack.isEmpty() || isInput(id(stack))) continue;
                    int rank=fuelRank(id(stack));
                    if(rank==0 || (!burning.isEmpty() && !id(stack).equals(id(burning)))) continue;
                    if(rank>best) {best=rank;bestValue=fuelValue(id(stack));fuelSlot=slot;}
                }
                if(fuelSlot<0) throw new IllegalStateException("no_usable_fuel: nothing burnable in inventory");
                needFuel=(int)Math.ceil((remaining-covered)/bestValue);
                needFuel=Math.min(needFuel,mc.player.containerMenu.getSlot(fuelSlot).getItem().getCount());
            }
            inserted=0;stage=needInput>0?3:needFuel>0?6:9;return null;
        }
        if(stage==3) {click(mc,sourceSlot,0,ContainerInput.PICKUP);inserted=0;stage=4;return null;}
        if(stage==4) {
            if(!isInput(id(mc.player.containerMenu.getCarried()))) throw new IllegalStateException("cursor_ack_mismatch");
            click(mc,0,1,ContainerInput.PICKUP);
            PENDING.merge(item,1,Integer::sum);
            if(++inserted>=needInput) stage=5;
            return null;
        }
        if(stage==5) {
            if(!mc.player.containerMenu.getCarried().isEmpty()) click(mc,sourceSlot,0,ContainerInput.PICKUP);
            inserted=0;stage=needFuel>0?6:9;return null;
        }
        if(stage==6) {click(mc,fuelSlot,0,ContainerInput.PICKUP);inserted=0;stage=7;return null;}
        if(stage==7) {
            if(fuelValue(id(mc.player.containerMenu.getCarried()))<=0) throw new IllegalStateException("cursor_ack_mismatch");
            click(mc,1,1,ContainerInput.PICKUP);
            if(++inserted>=needFuel) stage=8;
            return null;
        }
        if(stage==8) {
            if(!mc.player.containerMenu.getCarried().isEmpty()) click(mc,fuelSlot,0,ContainerInput.PICKUP);
            stage=9;waitUntil=age+20;return null;
        }
        // Waiting on the furnace. Collect finished output, and go back and reassess if it has gone
        // idle -- out of fuel, or done with less than the batch we still owe.
        if(!output.isEmpty()) {
            if(!id(output).equals(item)) throw new IllegalStateException("smelting_output_mismatch");
            take(mc,output.getCount());return null;
        }
        if(count(mc,item)>=baseline+count) return "Smelted output observed in inventory: "+item;
        if(age>=waitUntil && (input.isEmpty() || (burning.isEmpty() && !lit(mc)))) {stage=2;waitUntil=age+20;}
        return null;
    }
    private void take(Minecraft mc,int collected) {
        click(mc,2,0,ContainerInput.QUICK_MOVE);
        PENDING.computeIfPresent(item,(key,left)->left-collected>0?left-collected:null);
    }
    private static boolean lit(Minecraft mc) {
        return mc.player.containerMenu instanceof FurnaceMenu furnace && furnace.isLit();
    }
}

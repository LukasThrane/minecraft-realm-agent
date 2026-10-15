package dev.windove.bridge;

import com.google.gson.*;
import java.util.*;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.*;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.cubemob.Slime;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;

/** Client-only sensing and actuation adapter. No integrated-server AI reads, no model calls. */
final class Survival {
    private final ThreatAssessment policy=new ThreatAssessment();
    private final Map<String,Vec3> positions=new HashMap<>();
    private final Map<String,Integer> reachable=new HashMap<>();
    private final Map<String,Entity> entities=new HashMap<>();
    private DamageSource lastDamage;
    private ThreatAssessment.Decision decision=new ThreatAssessment.Decision("","not assessed",List.of(),0);
    private JsonObject evidence=new JsonObject();
    private Map<EscapePlanner.Cell,List<EscapePlanner.Cell>> paths=Map.of();
    private Combat.Loadout loadout=Combat.unarmed();
    /** Committed escape path in world coordinates, so steering does not re-decide every tick. */
    private final ArrayDeque<Vec3> waypoints=new ArrayDeque<>();
    private EscapePlanner.Route route;
    private int routeAge, ticks;
    private String targetId="";
    private static final Gson GSON=new Gson();
    /** How long a committed escape path is trusted before it is searched again. */
    private static final int ROUTE_TTL=20;
    private static final double SEARCH_RADIUS=6, TURN_RATE=30, COMBAT_TURN_RATE=70;
    /** Arm's length: what can hit us regardless of what the ground graph says. */
    private static final double CONTACT_RANGE=4, CONTACT_HEIGHT=2.5;
    private static final int REACH_MEMORY=20;
    /** How much room we try to keep while giving ground, by what is coming at us. */
    private static final double KEEP_FROM_BLAST=6, KEEP_FROM_MELEE=3;

    void reset() {
        policy.reset();positions.clear();entities.clear();reachable.clear();lastDamage=null;paths=Map.of();ticks=0;
        waypoints.clear();route=null;routeAge=0;targetId="";loadout=Combat.unarmed();
        decision=new ThreatAssessment.Decision("","not assessed",List.of(),0);
        evidence=new JsonObject();evidence.addProperty("assessed",false);
    }
    JsonObject evidence() {return evidence;}
    String reason() {return decision.reason();}
    private static String type(Entity e) {return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).getPath();}
    private static String item(ItemStack stack) {return BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();}

    /** Best melee weapon in the hotbar. Hotbar only: no container access or inventory shuffling. */
    static int weaponSlot(Minecraft mc) {
        int best=-1;double bestDps=0;
        for(int i=0;i<9;i++) {
            double dps=Combat.dps(item(mc.player.getInventory().getItem(i)));
            if(dps>bestDps) {bestDps=dps;best=i;}
        }
        return best;
    }
    /**
     * What we could bring to a fight. Attacking is restricted to singleplayer on purpose: this
     * baseline has never been validated against server-side combat, latency or other players.
     */
    private static Combat.Loadout loadout(Minecraft mc) {
        int slot=weaponSlot(mc);
        String weapon=slot<0?"fists":item(mc.player.getInventory().getItem(slot));
        boolean enabled=mc.hasSingleplayerServer() && slot>=0;
        return new Combat.Loadout(weapon,Combat.dps(weapon),mc.player.getArmorValue(),
            mc.player.getFoodData().getFoodLevel()>6,enabled,mc.player.getMaxHealth());
    }

    /**
     * What we can actually take before dying: absorption hearts from a golden apple are hit points
     * like any other, and the maximum itself moves with attributes, so nothing here is a constant.
     */
    private static float health(Minecraft mc) {
        return mc.player.getHealth()+mc.player.getAbsorptionAmount();
    }
    String update(Minecraft mc) {
        long assessmentStarted=System.nanoTime();
        ticks++;
        loadout=loadout(mc);
        DamageSource damage=mc.player.getLastDamageSource();
        Entity attacker=damage!=null && damage!=lastDamage && (ticks>1 || mc.player.hurtTime>=9)?damage.getEntity():null;
        lastDamage=damage;
        Set<String> gone=new HashSet<>();
        for(var entry:entities.entrySet()) if(entry.getValue() instanceof LivingEntity living && living.isDeadOrDying()) gone.add(entry.getKey());
        policy.forgetDead(gone);

        // Pass one: what is nearby, and does anything justify searching for ground routes at all.
        List<Entity> nearby=new ArrayList<>();
        boolean candidate=false;
        Set<String> present=new HashSet<>();entities.clear();
        for(Entity e:mc.level.entitiesForRendering()) {
            if(e==mc.player || !(e instanceof LivingEntity) || !e.isAlive() || e.distanceTo(mc.player)>32) continue;
            nearby.add(e);
            String id=e.getUUID().toString();present.add(id);entities.put(id,e);
            candidate|=e==attacker || e.distanceTo(mc.player)<=16
                && (ThreatAssessment.hostile(type(e)) || e instanceof Mob mob && mob.isAggressive());
        }
        // Ground-only baseline. Search offsets retain the player's actual fractional position.
        // Standing in water is not a reason to stop looking for a way out. Requiring solid ground
        // here meant that in water nothing was reachable, nothing was accessible, no target was
        // ever engaged and the response collapsed to an indefinite hold while being hit.
        paths=candidate && grounded(mc)
            ?EscapePlanner.reachable((a,b)->edge(mc,a,b),(int)SEARCH_RADIUS):Map.of();

        // Pass two: turn each entity into an observation, including whether it can actually reach us.
        List<ThreatAssessment.Seen> seen=new ArrayList<>();
        for(Entity e:nearby) {
            String id=e.getUUID().toString(),kind=type(e);
            Vec3 old=positions.put(id,e.position());
            Vec3 towards=mc.player.position().subtract(e.position());
            boolean closing=old!=null && e.position().subtract(old).dot(towards.normalize())>0.025;
            boolean hostile=ThreatAssessment.hostile(kind) || (kind.equals("slime") && e instanceof Slime slime && slime.getSize()>1);
            boolean aggressive=e instanceof Mob mob && mob.isAggressive();
            boolean visible=mc.player.hasLineOfSight(e);
            seen.add(new ThreatAssessment.Seen(id,"minecraft:"+kind,e.getX(),e.getY(),e.getZ(),e.distanceTo(mc.player),
                visible,accessible(mc,e),hostile,ThreatAssessment.airborneOrRanged(kind),
                aggressive,closing,
                e instanceof Creeper creeper && (creeper.isIgnited() || creeper.getSwellDir()>0),
                e==attacker,ThreatAssessment.meleeSupported(kind),
                Combat.outrunsUs(kind) || e instanceof LivingEntity baby && baby.isBaby(),
                ((LivingEntity)e).getHealth()));
        }
        positions.keySet().retainAll(present);reachable.keySet().retainAll(present);

        ThreatAssessment.Assessment assessment=policy.assess(seen);
        List<EscapePlanner.Threat> threats=assessment.threats().stream().map(e->new EscapePlanner.Threat(
            e.entity().x()-mc.player.getX(),e.entity().y()-mc.player.getY(),e.entity().z()-mc.player.getZ())).toList();
        planRetreat(mc,threats);
        decision=policy.respond(assessment,health(mc),loadout,!waypoints.isEmpty());
        if(!decision.mode().equals("retreat")) {waypoints.clear();route=null;}
        if(!decision.mode().equals("fight") && !decision.mode().equals("kite")) targetId="";

        publish(mc,seen,damage,attacker,assessmentStarted);
        return decision.mode();
    }

    /**
     * Keep a committed path while it stays valid, and search again when it does not. Re-searching
     * every tick let the chosen direction flip between neighbouring cells from one tick to the
     * next, which is how a retreat turned into cardinal zig-zagging instead of leaving the area.
     */
    private void planRetreat(Minecraft mc,List<EscapePlanner.Threat> threats) {
        if(threats.isEmpty()) {waypoints.clear();route=null;return;}
        while(!waypoints.isEmpty() && reached(mc,waypoints.peek())) waypoints.poll();
        routeAge++;
        // Mid-jump or mid-fall there is no ground to search from and no way to validate a step
        // against the body's current position, so an existing commitment is kept rather than
        // dropped and instantly reported as "no escape route".
        int ttl=decision.threats().stream().anyMatch(e->e.entity().type().endsWith("creeper"))?ROUTE_TTL/4:ROUTE_TTL;
        if(!waypoints.isEmpty() && (!grounded(mc) || routeAge<=ttl && walkable(mc,waypoints.peek()))) return;
        if(!grounded(mc)) return;
        route=EscapePlanner.choose(paths,threats);
        waypoints.clear();routeAge=0;
        if(route==null) return;
        Vec3 origin=mc.player.position();
        for(EscapePlanner.Cell step:route.steps())
            waypoints.add(new Vec3(origin.x+step.x(),origin.y+step.y(),origin.z+step.z()));
    }
    private boolean reached(Minecraft mc,Vec3 point) {
        return Math.hypot(point.x-mc.player.getX(),point.z-mc.player.getZ())<0.55
            && Math.abs(point.y-mc.player.getY())<1.2;
    }
    private boolean walkable(Minecraft mc,Vec3 point) {
        return edge(mc,0,0,0,point.x-mc.player.getX(),point.y-mc.player.getY(),point.z-mc.player.getZ());
    }

    /**
     * Leave the hazard on foot, steering straight at the nearest safe stand.
     *
     * No route search: the search wants ground to stand on, and standing is the thing we are
     * currently failing to do. Facing first and only then walking matters, because a target
     * behind us plus an immediate step forward is a step further into it.
     */
    void escapeHazard(Minecraft mc) {
        boolean lava=mc.player.isInLava();
        HazardEscape.Spot spot=escapeSpot(mc);
        if(spot==null) { if(lava) mc.options.keyJump.setDown(true); return; }
        double dx=spot.x()+0.5-mc.player.getX(), dz=spot.z()+0.5-mc.player.getZ();
        if(dx*dx+dz*dz>1e-4) {
            float wanted=(float)Math.toDegrees(Math.atan2(-dx,dz));
            turn(mc,wanted,0,COMBAT_TURN_RATE);
            float off=Math.abs(net.minecraft.util.Mth.wrapDegrees(mc.player.getYRot()-wanted));
            if(off<60) mc.options.keyUp.setDown(true);
        }
        // Swimming in lava is upward before it is sideways, and a shore is usually a step up.
        if(lava || spot.y()>mc.player.getBlockY() || mc.player.horizontalCollision) mc.options.keyJump.setDown(true);
    }
    private static HazardEscape.Spot escapeSpot(Minecraft mc) {
        return HazardEscape.nearest(new HazardEscape.World() {
            public boolean known(int x,int y,int z) {return mc.level.hasChunkAt(new BlockPos(x,y,z));}
            public boolean hazard(int x,int y,int z) {
                BlockPos pos=new BlockPos(x,y,z);
                if(!mc.level.hasChunkAt(pos)) return true;
                if(mc.level.getFluidState(pos).is(net.minecraft.tags.FluidTags.LAVA)) return true;
                return HAZARDS.contains(BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(pos).getBlock()).getPath());
            }
            public boolean solid(int x,int y,int z) {
                BlockPos pos=new BlockPos(x,y,z);
                return !mc.level.getBlockState(pos).getCollisionShape(mc.level,pos).isEmpty();
            }
        },mc.player.getBlockX(),mc.player.getBlockY(),mc.player.getBlockZ());
    }

    void drive(Minecraft mc) {
        if(decision.mode().equals("retreat")) retreat(mc);
        else if(decision.mode().equals("fight")) fight(mc);
        else if(decision.mode().equals("kite")) kite(mc);
    }

    /**
     * Give ground while facing the thing, and hit it if it comes into reach.
     *
     * This is the answer to everything that used to be a hold with something standing next to us:
     * a creeper that cannot close cannot detonate on us, and a mob we are backing away from is a
     * mob whose swings fall short. It needs no planned route -- a step at a time, checked as it
     * goes -- which matters because the route search is exactly what is unavailable when we are
     * jammed against terrain.
     */
    private void kite(Minecraft mc) {
        Entity target=target(mc);
        if(target==null) {
            ThreatAssessment.Evidence nearest=decision.threats().isEmpty()?null:decision.threats().getFirst();
            if(nearest==null) return;
            faceAway(mc,nearest.entity().x(),nearest.entity().z());
            return;
        }
        Vec3 delta=target.getBoundingBox().getCenter().subtract(mc.player.getEyePosition());
        turn(mc,(float)Math.toDegrees(Math.atan2(-delta.x,delta.z)),
            (float)-Math.toDegrees(Math.atan2(delta.y,Math.hypot(delta.x,delta.z))),COMBAT_TURN_RATE);
        boolean explosive=Combat.burst(strip(target)) || decision.reason().contains("creeper");
        double keep=explosive?KEEP_FROM_BLAST:KEEP_FROM_MELEE;
        if(mc.player.distanceTo(target)<keep && backStep(mc,target)) mc.options.keyDown.setDown(true);
        if(!explosive && mc.gameMode!=null && mc.player.hasLineOfSight(target)
                && mc.player.getAttackStrengthScale(0)>=0.95f
                && mc.player.isWithinAttackRange(mc.player.getMainHandItem(),target.getBoundingBox(),0)) {
            int slot=weaponSlot(mc);
            if(slot>=0) mc.player.getInventory().setSelectedSlot(slot);
            mc.gameMode.attack(mc.player,target);mc.player.swing(InteractionHand.MAIN_HAND);
        }
    }
    private static String strip(Entity e) {
        return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).getPath();
    }
    /** Is the single step directly backwards actually walkable? Checked every tick, never assumed. */
    private boolean backStep(Minecraft mc,Entity from) {
        Vec3 away=new Vec3(mc.player.getX()-from.getX(),0,mc.player.getZ()-from.getZ());
        if(away.lengthSqr()<1e-4) return false;
        away=away.normalize();
        return edge(mc,0,0,0,away.x,0,away.z) || edge(mc,0,0,0,away.x*0.5,0,away.z*0.5);
    }
    /** Turn our back on something when we have no entity handle for it, and walk. */
    private void faceAway(Minecraft mc,double x,double z) {
        double dx=mc.player.getX()-x, dz=mc.player.getZ()-z;
        if(dx*dx+dz*dz<1e-4) return;
        turn(mc,(float)Math.toDegrees(Math.atan2(-dx,dz)),0,TURN_RATE);
        if(edge(mc,0,0,0,dx/Math.hypot(dx,dz),0,dz/Math.hypot(dx,dz))) mc.options.keyUp.setDown(true);
    }

    private void retreat(Minecraft mc) {
        if(waypoints.isEmpty()) return;
        // Aim at the furthest step still reachable in a straight line: a continuous heading rather
        // than the next grid cell, which is what made every turn a right angle.
        Vec3 aim=waypoints.peek();
        int lookahead=0;
        for(Vec3 candidate:waypoints) {
            if(lookahead++==0) continue;
            if(lookahead>6 || Math.abs(candidate.y-aim.y)>0.5 || !walkable(mc,candidate)) break;
            aim=candidate;
        }
        double dx=aim.x-mc.player.getX(), dz=aim.z-mc.player.getZ();
        turn(mc,(float)Math.toDegrees(Math.atan2(-dx,dz)),0,TURN_RATE);
        mc.options.keyUp.setDown(true);
        if(loadout.canSprint() && Math.hypot(dx,dz)>1.0) mc.options.keySprint.setDown(true);
        // Jump for a step, when we are stuck against geometry, and to stay at the surface while
        // swimming out: sinking mid-retreat is how a withdrawal turns into a drowning.
        if(aim.y>mc.player.getY()+0.4 || mc.player.horizontalCollision || mc.player.isInWater()) mc.options.keyJump.setDown(true);
    }

    private void fight(Minecraft mc) {
        Entity target=target(mc);
        // Bare hands still hit. Requiring a weapon here meant that after a death dropped our kit,
        // the policy decided to fight and the body then did nothing at all -- standing still while
        // being killed, which is exactly what it looked like.
        int slot=weaponSlot(mc);
        if(target==null) return;
        if(slot>=0) mc.player.getInventory().setSelectedSlot(slot);
        Vec3 delta=target.getBoundingBox().getCenter().subtract(mc.player.getEyePosition());
        turn(mc,(float)Math.toDegrees(Math.atan2(-delta.x,delta.z)),
            (float)-Math.toDegrees(Math.atan2(delta.y,Math.hypot(delta.x,delta.z))),COMBAT_TURN_RATE);
        // Close the distance on foot. No sprint: a sprint hit trades reach for knockback we then
        // have to walk off again, and this baseline has no chase behaviour.
        if(mc.player.distanceTo(target)>2.6) mc.options.keyUp.setDown(true);
        if(mc.gameMode!=null && mc.player.hasLineOfSight(target)
                && mc.player.getAttackStrengthScale(0)>=0.95f
                && mc.player.isWithinAttackRange(mc.player.getMainHandItem(),target.getBoundingBox(),0)) {
            mc.gameMode.attack(mc.player,target);mc.player.swing(InteractionHand.MAIN_HAND);
        }
    }
    /** Stay on one target until it dies or leaves; swapping every tick kills nothing. */
    private Entity target(Minecraft mc) {
        Entity held=entities.get(targetId);
        if(held!=null && held.isAlive() && mc.player.distanceTo(held)<=ThreatAssessment.ENGAGE_MELEE) return held;
        Entity best=null;double nearest=Double.MAX_VALUE;
        boolean kiting=decision.mode().equals("kite");
        for(ThreatAssessment.Evidence e:decision.threats()) {
            // While kiting, the thing we are backing away from is the target whatever it is: the
            // creeper is precisely the one we must keep our eyes on.
            if(e.age()!=0 || !e.entity().visible() || !(kiting || e.entity().meleeSupported())) continue;
            Entity candidate=entities.get(e.entity().id());
            if(candidate==null || !candidate.isAlive() || e.entity().distance()>=nearest) continue;
            nearest=e.entity().distance();best=candidate;
        }
        targetId=best==null?"":best.getUUID().toString();
        return best;
    }
    /** Rotate towards a heading at a bounded rate, so control stays smooth and legible. */
    private static void turn(Minecraft mc,float yaw,float pitch,double rate) {
        float delta=net.minecraft.util.Mth.wrapDegrees(yaw-mc.player.getYRot());
        mc.player.setYRot(mc.player.getYRot()+(float)Math.max(-rate,Math.min(rate,delta)));
        mc.player.setXRot(Math.max(-90,Math.min(90,pitch)));
    }

    /**
     * Can this entity and we actually reach each other right now?
     *
     * Three sources, because the route search alone is too brittle to hang engagement on: it needs
     * a ground graph, and mid-jump, mid-fall or in water there is none. Anything at arm's length
     * with line of sight can hit us whatever the graph says, and a recent yes is kept briefly so
     * the answer does not flicker tick by tick and cancel a fight that was already justified.
     */
    private boolean accessible(Minecraft mc,Entity e) {
        double dy=Math.abs(e.getY()-mc.player.getY());
        boolean now=dy<=CONTACT_HEIGHT && mc.player.distanceTo(e)<=CONTACT_RANGE && mc.player.hasLineOfSight(e);
        if(!now && dy<=1.25 && !paths.isEmpty()) now=paths.keySet().stream().anyMatch(c->
            Math.hypot(mc.player.getX()+c.x()-e.getX(),mc.player.getZ()+c.z()-e.getZ())<=1.5
            && edge(mc,c.x(),c.y(),c.z(),e.getX()-mc.player.getX(),c.y(),e.getZ()-mc.player.getZ()));
        String id=e.getUUID().toString();
        if(now) {reachable.put(id,ticks);return true;}
        Integer last=reachable.get(id);
        return last!=null && ticks-last<=REACH_MEMORY && mc.player.distanceTo(e)<=ThreatAssessment.ENGAGE_MELEE;
    }
    private static boolean grounded(Minecraft mc) {
        return mc.player.onGround() || mc.player.isInWater();
    }

    private void publish(Minecraft mc,List<ThreatAssessment.Seen> seen,DamageSource damage,Entity attacker,long started) {
        evidence=new JsonObject();
        evidence.addProperty("assessed",true);evidence.addProperty("tick",ticks);
        evidence.addProperty("mode",decision.mode());evidence.addProperty("reason",decision.reason());
        evidence.addProperty("episodeTicks",decision.episodeTicks());
        evidence.addProperty("damageSource",damage==null?"none":damage.getMsgId());
        evidence.addProperty("newAttributedDamage",attacker!=null);
        evidence.addProperty("health",health(mc));
        evidence.addProperty("maxHealth",mc.player.getMaxHealth());
        evidence.addProperty("absorption",mc.player.getAbsorptionAmount());
        evidence.addProperty("maxHealth",mc.player.getMaxHealth());
        evidence.addProperty("food",mc.player.getFoodData().getFoodLevel());
        evidence.addProperty("weapon",loadout.weapon());evidence.addProperty("weaponDps",loadout.weaponDps());
        evidence.addProperty("armor",loadout.armor());evidence.addProperty("fightEnabled",loadout.enabled());
        evidence.addProperty("target",targetId);
        evidence.addProperty("x",mc.player.getX());evidence.addProperty("y",mc.player.getY());evidence.addProperty("z",mc.player.getZ());
        // Heading and gait are published because "it turns in right angles and never gets away"
        // is a movement claim, and it should be answerable from the journal rather than by eye.
        evidence.addProperty("yaw",mc.player.getYRot());evidence.addProperty("sprinting",mc.player.isSprinting());
        evidence.addProperty("onGround",mc.player.onGround());
        evidence.add("threats",GSON.toJsonTree(decision.threats()));
        evidence.add("nearby",GSON.toJsonTree(seen));
        if(route!=null) evidence.add("route",GSON.toJsonTree(route));
        if(!waypoints.isEmpty()) {
            Vec3 next=waypoints.peek();
            JsonObject aim=new JsonObject();
            aim.addProperty("x",next.x);aim.addProperty("y",next.y);aim.addProperty("z",next.z);
            aim.addProperty("remaining",waypoints.size());aim.addProperty("age",routeAge);
            evidence.add("waypoint",aim);
        }
        evidence.addProperty("reachableCells",paths.size());
        evidence.addProperty("assessmentMicros",(System.nanoTime()-started)/1000);
    }

    private static boolean edge(Minecraft mc,EscapePlanner.Cell from,EscapePlanner.Cell to) {
        return edge(mc,from.x(),from.y(),from.z(),to.x(),to.y(),to.z());
    }
    private static boolean edge(Minecraft mc,double fromX,double fromY,double fromZ,double toX,double toY,double toZ) {
        // Water blocks a route we would be walking into, but once we are already swimming it is
        // the only way back to land, so refusing to cross it just leaves us stuck in it.
        boolean wet=mc.player.isInWater();
        var bounds=mc.player.getBoundingBox();
        var body=new GroundSafety.Box(bounds.minX,bounds.minY,bounds.minZ,bounds.maxX,bounds.maxY,bounds.maxZ);
        return GroundSafety.edge(new GroundSafety.World() {
            public boolean clear(GroundSafety.Box b) {
                return mc.level.noCollision(mc.player,new net.minecraft.world.phys.AABB(b.minX(),b.minY(),b.minZ(),b.maxX(),b.maxY(),b.maxZ()));
            }
            public boolean hazardous(int x,int y,int z) {
                BlockPos p=new BlockPos(x,y,z);
                if(!mc.level.hasChunkAt(p)) return true;
                var fluid=mc.level.getFluidState(p);
                if(!fluid.isEmpty()) return !(wet && fluid.is(net.minecraft.tags.FluidTags.WATER));
                String block=BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(p).getBlock()).getPath();
                return HAZARDS.contains(block);
            }
        },body,fromX,fromY,fromZ,toX,toY,toZ);
    }
    private static final Set<String> HAZARDS=Set.of("lava","fire","soul_fire","magma_block","cactus",
        "sweet_berry_bush","powder_snow","campfire","soul_campfire","wither_rose");
}

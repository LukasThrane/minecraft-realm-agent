package dev.windove.bridge;

import java.util.*;

/**
 * Runs the production policy, combat arithmetic and route search against observed sequences and
 * voxel terrain fixtures. Nothing here is mocked to return the expected answer: every check calls
 * the same code the client tick calls, with only the Minecraft-side sensing replaced by fixtures.
 */
public final class SurvivalTest {
    private static int checks;
    private static void check(boolean ok,String why) {checks++;if(!ok) throw new AssertionError(why);}
    private static ThreatAssessment.Seen seen(String type,double distance,boolean visible,boolean accessible,
                                             boolean aggressive,boolean closing,boolean damage) {
        return seen(type,distance,visible,accessible,aggressive,closing,damage,20);
    }
    private static ThreatAssessment.Seen seen(String type,double distance,boolean visible,boolean accessible,
                                             boolean aggressive,boolean closing,boolean damage,double health) {
        return new ThreatAssessment.Seen("entity-"+type,type,distance,64,0,distance,visible,accessible,
            ThreatAssessment.hostile(type),ThreatAssessment.airborneOrRanged(type),aggressive,closing,false,damage,
            ThreatAssessment.meleeSupported(type),Combat.outrunsUs(type),health);
    }
    private static ThreatAssessment.Seen primed(double distance) {
        var base=seen("creeper",distance,true,true,true,true,false);
        return new ThreatAssessment.Seen(base.id(),base.type(),base.x(),base.y(),base.z(),base.distance(),
            true,true,true,false,true,true,true,false,false,false,base.health());
    }
    /** A baby zombie is an ordinary zombie profile that a sprint cannot outrun. */
    private static ThreatAssessment.Seen baby(double distance) {
        var b=seen("zombie",distance,true,true,true,true,false);
        return new ThreatAssessment.Seen(b.id(),b.type(),b.x(),b.y(),b.z(),b.distance(),true,true,
            b.hostile(),false,true,true,false,false,true,true,b.health());
    }
    private static Combat.Loadout armed(String weapon) {
        return new Combat.Loadout(weapon,Combat.dps(weapon),0,true,true);
    }
    private static Combat.Loadout armed(String weapon,double armor) {
        return new Combat.Loadout(weapon,Combat.dps(weapon),armor,true,true);
    }
    private static Combat.Loadout armed(String weapon,double armor,double maxHealth) {
        return new Combat.Loadout(weapon,Combat.dps(weapon),armor,true,true,maxHealth);
    }
    private static ThreatAssessment.Decision run(ThreatAssessment p,ThreatAssessment.Seen s,boolean weapon,boolean route) {
        return p.update(List.of(s),20,weapon?armed("stone_sword"):Combat.unarmed(),route);
    }
    public static void main(String[] args) {
        var contactBody=new GroundSafety.Box(0.2,1,0.2,0.8,2.8,0.8);
        check(ContactHazards.projected((x,y,z)->x==2 && y==1,contactBody,0.35,0,0),"task movement stops before projected lava contact");
        check(!ContactHazards.projected((x,y,z)->x==2 && y==1,contactBody,-0.2,0,0),"movement away from lava is allowed");
        check(!ContactHazards.projected((x,y,z)->false,contactBody,0.35,0,0),"clear task movement continues");
        escapeChecks();

        threatChecks();
        combatArithmeticChecks();
        fightOrFlightChecks();
        searchChecks();
        loadoutChecks();
        terrainChecks();
        System.out.println("Survival production policy/combat/search: "+checks+" checks passed");
    }

    /** What counts as a credible threat at all: proximity is not danger. */
    /**
     * Standing in lava, the safety tier must pick somewhere to stand, not merely refuse to move.
     * A voxel world: stone floor at y=0, a lava pool over x in 0..2, shore from x=3.
     */
    private static void escapeChecks() {
        HazardEscape.World pool=new HazardEscape.World() {
            public boolean known(int x,int y,int z) {return Math.abs(x)<=16 && Math.abs(z)<=16 && y>=-4 && y<=8;}
            public boolean hazard(int x,int y,int z) {return y==1 && x>=0 && x<=2 && z>=-1 && z<=1;}
            public boolean solid(int x,int y,int z) {return y<=0;}
        };
        HazardEscape.Spot out=HazardEscape.nearest(pool,1,1,0);
        check(out!=null,"a body in lava is given somewhere to stand");
        check(!pool.hazard(out.x(),out.y(),out.z()),"the chosen spot is not itself on fire");
        check(HazardEscape.stands(pool,out.x(),out.y(),out.z(),1),"the chosen spot keeps a block of clearance from the pool edge");
        check(out.y()==1,"walking out beats dropping into the unknown");
        check(Math.hypot(out.x()-1,out.z())<=3.1,"and it is the near shore, not a hike");
        // A single safe column in a lava field: no spot anywhere has a block of margin, and
        // standing on the one that merely is not on fire still beats staying in it.
        HazardEscape.World ledge=new HazardEscape.World() {
            public boolean known(int x,int y,int z) {return Math.abs(x)<=16 && Math.abs(z)<=16 && y>=-4 && y<=8;}
            public boolean hazard(int x,int y,int z) {return y==1 && x!=4;}
            public boolean solid(int x,int y,int z) {return y<=0;}
        };
        check(HazardEscape.nearest(ledge,0,1,0,1)==null,"no spot in this field has a block of clearance");
        HazardEscape.Spot shore=HazardEscape.nearest(ledge,0,1,0);
        check(shore!=null && shore.x()==4,"with no clear margin available it still leaves the lava");
        check(HazardEscape.nearest(pool,12,1,12)!=null,"safe ground far from any hazard is still a valid stand");
    }

    private static void threatChecks() {
        for(String type:List.of("cow","sheep","pig","enderman","zombified_piglin","piglin","spider","wolf","iron_golem","slime","unknown_mod_mob"))
            check(run(new ThreatAssessment(),seen(type,2,true,true,false,false,false),false,true).mode().isEmpty(),"nearby does not mean dangerous: "+type);
        check(run(new ThreatAssessment(),seen("zombie",3,false,false,false,false,false),false,true).mode().isEmpty(),"wall blocks threat opportunity");
        check(run(new ThreatAssessment(),seen("zombie",4,true,false,false,false,false),false,true).mode().isEmpty(),"vertical separation/window: LOS is insufficient for melee");
        check(run(new ThreatAssessment(),seen("zombie",4,true,true,false,false,false),false,true).mode().equals("retreat"),"exposed hostile");
        check(run(new ThreatAssessment(),seen("skeleton",10,true,false,false,false,false),false,true).mode().equals("retreat"),"ranged exposure across vertical gap");
        check(run(new ThreatAssessment(),seen("wolf",2,true,true,true,false,false),false,true).mode().isEmpty(),"aggression alone may target somebody else");
        check(run(new ThreatAssessment(),seen("wolf",2,true,true,true,true,false),false,true).mode().equals("retreat"),"aggression plus approach");
        var p=new ThreatAssessment();
        check(run(p,seen("wolf",3,false,false,false,false,true),false,true).mode().equals("retreat"),"attributed actual attack overrides type/visibility");
        for(int i=0;i<100;i++) check(!run(p,seen("wolf",3,false,false,false,false,false),false,true).mode().isEmpty(),"pursuit survives occlusion "+i);
        for(int i=0;i<39;i++) check(!p.update(List.of(),20,Combat.unarmed(),true).mode().isEmpty(),"clearance hysteresis");
        check(p.update(List.of(),20,Combat.unarmed(),true).mode().isEmpty(),"return to work after memory and stable clearance");
        p=new ThreatAssessment();
        for(int i=0;i<500;i++) {
            var d=run(p,seen("zombie",3,true,true,false,false,false),false,true);
            check(!d.mode().isEmpty(),"unchanged threat must never release work");
            // Once the movement budget is spent the answer is to hit the thing, not to stand in
            // front of it. Retreating forever and standing still are both ways of dying.
            if(i>=210) check(d.mode().equals("fight"),"a spent budget becomes a fight, never an idle hold");
        }
        check(run(new ThreatAssessment(),seen("zombie",3,true,true,false,false,false),false,false).mode().equals("fight"),
            "cornered with bare fists still beats being hit for free");
        p=new ThreatAssessment();
        run(p,seen("zombie",4,true,true,false,false,false),false,true);
        for(int i=0;i<140;i++) p.update(List.of(),20,Combat.unarmed(),true);
        run(p,seen("zombie",4,true,true,false,false,false),false,true);
        for(int i=0;i<200;i++) p.update(List.of(),20,Combat.unarmed(),true);
        check(p.update(List.of(),20,Combat.unarmed(),true).mode().equals("hold"),"return to same worksite cannot create endless resume loops");
        p.forgetDead(Set.of("entity-zombie"));
        for(int i=0;i<40;i++) p.update(List.of(),20,Combat.unarmed(),true);
        check(p.update(List.of(),20,Combat.unarmed(),true).mode().isEmpty(),"confirmed death releases worksite quarantine");
        p.reset();check(p.update(List.of(),20,Combat.unarmed(),true).mode().isEmpty(),"takeover/session resets memory");
    }

    /** The numbers the fight/flee choice is made from. */
    private static void combatArithmeticChecks() {
        check(Combat.damage("diamond_sword")==7 && Combat.damage("stone_sword")==5,"vanilla sword damage");
        check(Combat.damage("netherite_axe")==10 && Combat.damage("wooden_axe")==7,"axes do not follow the tier formula");
        check(Combat.damage("stone_pickaxe")==3 && Combat.damage("cobblestone")==0,"only weapons are weapons");
        check(Combat.dps("diamond_sword")>Combat.dps("stone_axe"),"a diamond sword out-damages a stone axe");
        check(Combat.dps("fists")==2,"hurt immunity caps unarmed damage at two hits per second");
        check(Combat.armorMultiplier(0)==1 && Math.abs(Combat.armorMultiplier(20)-0.2)<1e-9,"vanilla armour reduction");
        check(Combat.fightable("zombie") && !Combat.fightable("creeper") && !Combat.fightable("skeleton")
            && !Combat.fightable("iron_golem") && !Combat.fightable("warden"),"fightable excludes explosive, ranged and unwinnable mobs");
        check(Combat.outrunsUs("spider") && !Combat.outrunsUs("zombie"),"a sprint outruns a zombie but not a spider");
        var one=List.of(new Combat.Target("zombie",20));
        check(Combat.plan(one,20,armed("stone_sword")).winnable(),"one zombie, healthy, stone sword");
        check(!Combat.plan(one,20,Combat.unarmed()).winnable(),"capability gate: unarmed is not a fight");
        check(!Combat.plan(one,20,armed("wooden_hoe")).winnable(),"a hoe is not a weapon worth trading hits with");
        check(!Combat.plan(one,10,armed("stone_sword")).winnable(),"the same fight is refused at half health");
        check(Combat.plan(one,10,armed("diamond_sword",20)).winnable(),"armour and a better weapon change that answer");
        check(!Combat.plan(List.of(new Combat.Target("zombie",20),new Combat.Target("zombie",20),
            new Combat.Target("zombie",20)),20,armed("stone_sword")).winnable(),"three at once is not one three times");
        check(Combat.plan(List.of(new Combat.Target("zombie",20),new Combat.Target("zombie",20)),
            20,armed("netherite_sword",20)).winnable(),"geared up, two is fine");
        check(!Combat.plan(List.of(new Combat.Target("zombie",20),new Combat.Target("creeper",20)),
            20,armed("diamond_sword",20)).allFightable(),"a creeper in the group cancels the fight");
        // Thresholds follow our actual maximum, which is an attribute and can change in play.
        check(!Combat.plan(one,15,armed("stone_sword",0,44)).winnable(),"a third of a 44-point bar is not a healthy fight");
        check(Combat.plan(one,15,armed("stone_sword",0,20)).winnable(),"the same 15 points is healthy when 20 is full");
        check(Combat.reserve(44)>Combat.reserve(20),"the reserve scales with the bar");
        double weak=Combat.plan(one,20,armed("stone_sword")).expectedDamage();
        double strong=Combat.plan(one,20,armed("diamond_sword")).expectedDamage();
        check(strong<weak,"a faster kill takes fewer hits in return");
    }

    /** Choosing between working, fighting, retreating and holding. */
    private static void fightOrFlightChecks() {
        check(run(new ThreatAssessment(),seen("zombie",2,true,true,false,false,false),true,true).mode().equals("fight"),"supported equipped defensive melee");
        check(new ThreatAssessment().update(List.of(seen("zombie",2,true,true,false,false,false)),10,armed("stone_sword"),true)
            .mode().equals("retreat"),"low health avoids fight");
        check(run(new ThreatAssessment(),seen("creeper",2,true,true,false,false,false),true,true).mode().equals("retreat"),"no creeper melee");
        check(new ThreatAssessment().update(List.of(primed(2)),20,armed("diamond_sword",20),true).mode().equals("retreat"),"a primed creeper is never a damage race");
        check(new ThreatAssessment().update(List.of(seen("zombie",2,true,true,false,false,false),seen("skeleton",4,true,true,false,false,false)),
            20,armed("stone_sword"),true).mode().equals("retreat"),"covering fire from something we cannot reach cancels the fight");
        check(new ThreatAssessment().update(List.of(seen("zombie",2,true,true,false,false,false),seen("zombie",3,true,true,false,false,false),
            seen("zombie",4,true,true,false,false,false),seen("zombie",5,true,true,false,false,false)),
            20,armed("stone_sword"),true).mode().equals("retreat"),"outnumbered: withdraw rather than trade");
        check(new ThreatAssessment().update(List.of(seen("zombie",2,true,true,false,false,false),seen("zombie",3,true,true,false,false,false)),
            20,armed("netherite_sword",20),true).mode().equals("fight"),"the same pair is a fight when geared for it");
        // The recorded failure: a spider a metre away, which a sprint cannot outrun.
        var p=new ThreatAssessment();
        check(p.update(List.of(seen("spider",1.4,true,true,true,true,false,16)),20,armed("stone_sword"),true)
            .mode().equals("fight"),"an adjacent spider is fought, not fled from");
        check(new ThreatAssessment().update(List.of(seen("spider",1.4,true,true,true,true,false,16)),20,Combat.unarmed(),true)
            .mode().equals("retreat"),"without a weapon the same spider is a retreat while there is somewhere to go");
        // Commitment: having decided to swing, do not drop it again on the very next tick.
        var committed=new ThreatAssessment();
        check(committed.update(List.of(seen("zombie",2,true,true,false,false,false)),20,armed("stone_sword"),true)
            .mode().equals("fight"),"the fight starts");
        check(committed.update(List.of(seen("zombie",5,true,true,false,false,false)),20,armed("stone_sword"),true)
            .mode().equals("fight"),"and is not abandoned the moment the target steps back");
        check(new ThreatAssessment().update(List.of(seen("zombie",3,true,true,false,false,false)),20,armed("stone_sword"),false)
            .mode().equals("fight"),"cornered with no route: defend rather than stand still");
        // The freeze this replaces: a threat we can neither fight nor route away from used to be
        // answered by standing still until it killed us.
        var stranded=new ThreatAssessment();
        check(stranded.update(List.of(seen("zombie",4,true,true,false,false,false)),20,Combat.unarmed(),false)
            .mode().equals("fight"),"in reach and cornered: fight it");
        check(stranded.update(List.of(seen("zombie",14,true,false,false,false,false)),20,Combat.unarmed(),false)
            .mode().equals("hold"),"but something out of everyone's reach is not worth walking backwards from");
        // Cornered by a creeper: never trade hits, but never stand there either.
        check(new ThreatAssessment().update(List.of(seen("creeper",3,true,true,false,false,false)),20,armed("stone_sword"),false)
            .mode().equals("kite"),"cornered by a creeper is answered by giving ground, not by standing still");
        check(new ThreatAssessment().update(List.of(primed(2)),20,armed("stone_sword"),false)
            .mode().equals("kite"),"a primed creeper with nowhere to run is backed away from");
        check(new ThreatAssessment().update(List.of(seen("skeleton",11,true,false,false,false,false)),20,armed("stone_sword"),false)
            .mode().equals("kite"),"an archer we cannot route away from is still worth backing away from");
        // Cornered by things we can hit, whatever the arithmetic says about winning.
        check(new ThreatAssessment().update(List.of(seen("zombie",2,true,true,false,false,false),
            seen("zombie",3,true,true,false,false,false),seen("zombie",4,true,true,false,false,false)),
            8,armed("wooden_pickaxe"),false).mode().equals("fight"),"outnumbered and cornered is still a fight");
        check(new ThreatAssessment().update(List.of(seen("zombie",2,true,true,false,false,false)),20,Combat.unarmed(),false)
            .mode().equals("fight"),"no weapon is not a reason to stand still when we cannot leave");
        // Retreat that gains no ground escalates instead of freezing next to the attacker.
        p=new ThreatAssessment();
        var pursuing=seen("zombie",3,true,true,true,true,false);
        for(int i=0;i<59;i++) check(p.update(List.of(pursuing),20,armed("wooden_hoe"),true).mode().equals("retreat"),"retreat while it is still plausible");
        var stalled=p.update(List.of(pursuing),20,armed("wooden_hoe"),true);
        check(stalled.mode().equals("fight"),"a retreat that opens no separation becomes a fight");
        check(stalled.reason().contains("no separation gained"),"and says so: "+stalled.reason());
        p=new ThreatAssessment();
        for(int i=0;i<80;i++) p.update(List.of(seen("creeper",3,true,true,true,true,false)),20,armed("stone_sword"),true);
        check(p.update(List.of(seen("creeper",3,true,true,true,true,false)),20,armed("stone_sword"),true).mode().equals("retreat"),
            "escalation never turns a creeper into a target");
        p=new ThreatAssessment();
        run(p,seen("zombie",2,true,true,false,false,false),true,true);
        check(!p.update(List.of(),20,armed("stone_sword"),true).mode().equals("fight"),"unloaded target cannot retain visible melee capability");
        p=new ThreatAssessment();
        for(int i=0;i<250;i++) run(p,seen("spider",2,true,true,true,true,false),false,true);
        check(run(p,seen("spider",2,true,true,true,true,false),false,true).mode().equals("fight"),
            "a spider we cannot outrun and cannot leave is fought, armed or not");
        check(run(new ThreatAssessment(),seen("phantom",4,true,false,false,false,false),false,true).mode().equals("retreat"),"flying attacker needs no ground route");
        check(new ThreatAssessment().update(List.of(seen("phantom",4,true,false,false,false,false)),20,armed("diamond_sword",20),true)
            .mode().equals("retreat"),"a phantom still circling is not something we can chase");
        check(new ThreatAssessment().update(List.of(seen("phantom",2,true,true,true,true,false,20)),20,armed("iron_sword"),true)
            .mode().equals("fight"),"a phantom that has come within reach is swatted");
        check(!Combat.plan(List.of(new Combat.Target("phantom",20,false)),20,armed("diamond_sword")).allFightable(),
            "out of reach is out of the fight, however weak");
        // An explosion lands once. Charging it per second turned a two-mob estimate into nonsense.
        double burst=Combat.plan(List.of(new Combat.Target("creeper",20)),20,armed("iron_sword")).expectedDamage();
        check(burst<=25,"creeper damage is a single blast, not sustained dps: "+burst);
        // A baby zombie outruns a sprint, so withdrawing from one in contact is not a plan.
        check(new ThreatAssessment().update(List.of(baby(2)),20,armed("stone_sword"),true).mode().equals("fight"),
            "a pursuer a sprint cannot outrun is fought while we still can");
        check(new ThreatAssessment().update(List.of(baby(2)),20,Combat.unarmed(),true).mode().equals("retreat"),
            "the same pursuer without a weapon is still a withdrawal");
        // A skeleton beyond its own range is not a reason to keep backing away.
        var far=new ThreatAssessment();
        check(far.update(List.of(seen("skeleton",10,true,false,false,false,false)),20,armed("iron_sword"),true).mode().equals("retreat"),
            "within bow range, a skeleton is a threat");
        check(far.update(List.of(seen("skeleton",14,true,false,false,false,false)),20,armed("iron_sword"),true).mode().equals("hold"),
            "past bow range it stops driving a retreat, even after being seen");
        // Something left far behind stops driving a response, memory or not.
        p=new ThreatAssessment();
        check(run(p,seen("skeleton",10,true,false,false,false,false),false,true).mode().equals("retreat"),"ranged exposure holds while close");
        check(run(p,seen("skeleton",19,true,false,false,false,false),false,true).mode().equals("hold"),"beyond disengage range it stops being a threat");
        for(int i=0;i<40;i++) p.update(List.of(),20,Combat.unarmed(),true);
        check(p.update(List.of(),20,Combat.unarmed(),true).mode().isEmpty(),"and work resumes rather than retreating to the horizon");
    }

    /** The route search itself, independent of terrain. */
    private static void searchChecks() {
        EscapePlanner.Terrain flat=(a,b)->b.y()==0;
        var open=EscapePlanner.reachable(flat,4);
        check(open.size()==81,"bounded search visits 9x9 cells on one level");
        var threat=List.of(new EscapePlanner.Threat(2,0,0));
        var route=EscapePlanner.choose(open,threat);
        check(route!=null && route.clearance()>2,"escape improves separation");
        // A wall immediately west forces a sideways route around its end.
        EscapePlanner.Terrain walled=(a,b)->b.y()==0 && !(b.x()==-1 && Math.abs(b.z())<=1);
        route=EscapePlanner.choose(EscapePlanner.reachable(walled,4),threat);
        check(route!=null && route.steps().getFirst().x()==0,"blocked straight retreat uses detour");
        for(var c:route.steps()) check(!(c.x()==-1 && Math.abs(c.z())<=1),"route never crosses wall");
        check(EscapePlanner.choose(EscapePlanner.reachable((a,b)->false,4),threat)==null,"enclosed or unsupported ground: no blind movement");
        EscapePlanner.Terrain corridor=(a,b)->b.y()==0 && b.z()==0;
        check(EscapePlanner.choose(EscapePlanner.reachable(corridor,4),
            List.of(new EscapePlanner.Threat(2,0,0),new EscapePlanner.Threat(-2,0,0)))==null,"escape cannot run into second threat");
        // Vertical separation matters: a route that climbs away from a threat gains clearance.
        EscapePlanner.Terrain stairs=(a,b)->b.x()==0 && b.z()>=0 && b.y()==Math.min(b.z(),3);
        route=EscapePlanner.choose(EscapePlanner.reachable(stairs,4),List.of(new EscapePlanner.Threat(0,0,-1)));
        check(route!=null && route.steps().getLast().y()>0,"escape may climb, not only run flat");
        // Steering: aim at the furthest step still reachable in a straight line, not the next cell.
        var straight=EscapePlanner.reachable(flat,4);
        var aim=EscapePlanner.lookahead(straight.get(new EscapePlanner.Cell(4,0,0)),(a,b)->b.y()==0 && b.z()==0);
        check(aim.x()==4,"lookahead follows a straight corridor to its end");
        // Cost matters: this runs inside a client tick, next to everything else the frame owes.
        int[] calls={0};
        var all=EscapePlanner.reachable((a,b)->{calls[0]++;return true;},6);
        check(all.size()<=EscapePlanner.MAX_CELLS,"search never expands past its cell ceiling");
        check(calls[0]<3000,"open ground costs one edge check per direction, not one per level: "+calls[0]);
        var corner=EscapePlanner.lookahead(List.of(new EscapePlanner.Cell(1,0,0),new EscapePlanner.Cell(2,0,0),
            new EscapePlanner.Cell(2,0,1)),(a,b)->b.z()==0);
        check(corner.x()==2 && corner.z()==0,"lookahead stops at a turn it cannot cut");
    }

    /**
     * Kit ranking. Only the pure ranking is exercised here: the slot moves themselves talk to the
     * player's container menu and need a running client, so they are live-validated, not unit-tested.
     */
    private static void loadoutChecks() {
        check(Loadout.material("netherite_chestplate")>Loadout.material("diamond_chestplate"),"netherite outranks diamond");
        check(Loadout.material("diamond_sword")>Loadout.material("iron_sword"),"diamond outranks iron");
        check(Loadout.material("iron_helmet")>Loadout.material("chainmail_helmet"),"iron outranks chainmail");
        check(Loadout.material("turtle_helmet")==Loadout.material("iron_helmet"),"a turtle shell is iron-grade");
        check(Loadout.material("cobblestone")==0,"a block is not equipment");
    }

    /** Swept body movement over voxel terrain, shared by the live adapter and the search. */
    private static void terrainChecks() {
        record Voxel(int x,int y,int z) {}
        Set<Voxel> blocks=new HashSet<>(),hazards=new HashSet<>();
        for(int x=-8;x<=8;x++) for(int z=-8;z<=8;z++) blocks.add(new Voxel(x,-1,z));
        GroundSafety.World world=new GroundSafety.World() {
            public boolean clear(GroundSafety.Box b) {
                return blocks.stream().noneMatch(v->b.maxX()>v.x && b.minX()<v.x+1 && b.maxY()>v.y && b.minY()<v.y+1 && b.maxZ()>v.z && b.minZ()<v.z+1);
            }
            public boolean hazardous(int x,int y,int z) {return hazards.contains(new Voxel(x,y,z));}
        };
        var body=new GroundSafety.Box(0.2,0,0.2,0.8,1.8,0.8);
        check(GroundSafety.edge(world,body,0,0,3,0),"flat ground swept clearance");
        blocks.add(new Voxel(1,0,0));
        check(!GroundSafety.edge(world,body,0,0,3,0),"wall between clear endpoints blocks route");
        blocks.remove(new Voxel(1,0,0));blocks.add(new Voxel(1,1,0));
        check(!GroundSafety.edge(world,body,0,0,3,0),"head obstruction blocks route");
        blocks.remove(new Voxel(1,1,0));blocks.remove(new Voxel(1,-1,0));
        check(!GroundSafety.edge(world,body,0,0,3,0),"gap between endpoints blocks route");
        blocks.add(new Voxel(1,-1,0));hazards.add(new Voxel(1,-1,0));
        check(!GroundSafety.edge(world,body,0,0,3,0),"hazardous supporting block rejected");
        hazards.clear();hazards.add(new Voxel(1,0,0));
        check(!GroundSafety.edge(world,body,0,0,3,0),"water lava or contact hazard rejected");
        hazards.clear();
        // Step up one block, with and without headroom.
        blocks.add(new Voxel(1,-1,0));blocks.add(new Voxel(1,0,0));
        check(GroundSafety.edge(world,body,0,0,0,1,1,0),"one block step up is walkable");
        check(!GroundSafety.edge(world,body,0,0,0,1,0,0),"the same block is not walkable through");
        blocks.add(new Voxel(1,2,0));
        check(!GroundSafety.edge(world,body,0,0,0,1,1,0),"a step up needs headroom above it");
        blocks.remove(new Voxel(1,2,0));blocks.remove(new Voxel(1,0,0));
        check(!GroundSafety.edge(world,body,0,0,0,1,2,0),"two blocks up is a climb we cannot make");
        // Drop off a ledge: within survivable height only.
        blocks.remove(new Voxel(1,-1,0));blocks.add(new Voxel(1,-4,0));
        check(GroundSafety.edge(world,body,0,0,0,1,-3,0),"a three block drop is a legitimate escape");
        blocks.remove(new Voxel(1,-4,0));blocks.add(new Voxel(1,-5,0));
        check(!GroundSafety.edge(world,body,0,0,0,1,-4,0),"a four block drop hurts and is refused");
        blocks.remove(new Voxel(1,-5,0));blocks.add(new Voxel(1,-1,0));
        // Whole-search integration over the same voxel world.
        for(int z=-1;z<=1;z++) {blocks.add(new Voxel(-1,0,z));blocks.add(new Voxel(-1,1,z));}
        EscapePlanner.Terrain terrain=(a,b)->GroundSafety.edge(world,body,a.x(),a.y(),a.z(),b.x(),b.y(),b.z());
        var escape=EscapePlanner.choose(EscapePlanner.reachable(terrain,4),List.of(new EscapePlanner.Threat(2,0,0)));
        check(escape!=null,"production search plus swept voxel geometry finds wall detour");
        for(int z=-1;z<=1;z++) for(int x=-1;x<=1;x++) if(x!=0 || z!=0) {
            blocks.add(new Voxel(x,0,z));blocks.add(new Voxel(x,1,z));blocks.add(new Voxel(x,2,z));
        }
        check(EscapePlanner.choose(EscapePlanner.reachable(terrain,4),List.of(new EscapePlanner.Threat(2,0,0)))==null,
            "sealed house: no blind escape through wall, over it or under it");
    }
}

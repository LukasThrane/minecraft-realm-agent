package dev.windove.bridge;

import java.util.*;

/**
 * Client observations in, evidence and response out. No game classes or hidden AI targets.
 *
 * Two stages on purpose. `assess` turns what the client can see into credible-threat evidence and
 * owns the episode bookkeeping; `respond` is a pure choice over that evidence, our loadout and
 * whether an escape route actually exists. The adapter needs the threat set before it can search
 * for a route, and the route result changes the answer, so the split keeps both honest instead of
 * asking for a decision twice per tick.
 */
final class ThreatAssessment {
    static final int MEMORY_TICKS=100, CLEAR_TICKS=40, MOTION_BUDGET=200, STALLED_TICKS=60;
    /** Separation we expect a working retreat to have opened up after STALLED_TICKS. */
    static final double STALLED_GAIN=2.0;
    static final double ENGAGE_MELEE=6, ENGAGE_RANGED=12, CONTACT=3.5;
    /** Close enough that giving ground beats standing still: anything that can reach us. */
    static final double KITE_RANGE=ENGAGE_RANGED;
    /** Beyond this a credible threat stops being one, memory or not. */
    static final double DISENGAGE=18;

    record Seen(String id, String type, double x, double y, double z, double distance,
                boolean visible, boolean accessible, boolean hostile, boolean airborneOrRanged,
                boolean aggressive, boolean closing, boolean primed, boolean damagedUs,
                boolean meleeSupported, boolean fast, double health) {}
    record Evidence(Seen entity, String reason, int age) {}
    record Assessment(List<Evidence> threats, List<Evidence> quarantine, int episodeTicks,
                      double nearest, boolean losingGround, boolean budgetExhausted, boolean settling) {}
    record Decision(String mode, String reason, List<Evidence> threats, int episodeTicks) {}
    private record Memory(Seen seen, int confirmed) {}

    private final Map<String,Memory> memory=new HashMap<>();
    private final Map<String,Memory> previousEncounters=new HashMap<>();
    private final Map<String,Seen> repeatedSites=new HashMap<>();
    private int tick, quiet, episodeTicks, responseTicks, lastAttack=-1000;
    private Set<String> engagedIds=new HashSet<>();
    private double startNearest;
    private boolean episode;

    void forgetDead(Set<String> ids) {
        ids.forEach(id->{memory.remove(id);previousEncounters.remove(id);repeatedSites.remove(id);});
    }
    void reset() {
        memory.clear();previousEncounters.clear();repeatedSites.clear();
        tick=quiet=episodeTicks=responseTicks=0;lastAttack=-1000;episode=false;startNearest=0;engagedIds=new HashSet<>();
        committed="";committedAt=-1000;
    }

    Assessment assess(List<Seen> observations) {
        tick++;
        previousEncounters.entrySet().removeIf(e->tick-e.getValue().confirmed()>1200);
        List<Evidence> threats=new ArrayList<>();
        Set<String> present=new HashSet<>();
        for(Seen s:observations) {
            present.add(s.id());
            Memory prior=memory.get(s.id());
            Seen site=repeatedSites.get(s.id());
            if(site!=null && Math.hypot(site.x()-s.x(),site.z()-s.z())>8) repeatedSites.remove(s.id());
            // Type is a prior, not proof. Melee needs a local route; ranged needs exposure.
            // Reacquisition is wider than first contact because a pursuer that ducked behind cover
            // is still a pursuer -- but something that shoots has to be within its own range to be
            // a threat at all, so a skeleton fifteen metres away stops driving a retreat.
            double radius=s.airborneOrRanged()?ENGAGE_RANGED:prior==null?5:16;
            boolean opportunity=s.visible() && s.distance()<=radius && (s.airborneOrRanged() || s.accessible());
            String why=s.damagedUs()?"damage packet attributed to entity":
                s.primed() && s.visible() && s.distance()<=7?"visible primed creeper":
                opportunity && s.hostile()?"hostile profile with attack opportunity":
                opportunity && s.aggressive() && s.closing()?"aggression signal and observed approach":"";
            if(!why.isEmpty()) {
                Memory previous=previousEncounters.get(s.id());
                if(!episode && previous!=null && Math.hypot(previous.seen().x()-s.x(),previous.seen().z()-s.z())<=8)
                    repeatedSites.put(s.id(),s);
                memory.put(s.id(),new Memory(s,tick));
                threats.add(new Evidence(s,why,0));
            } else if(prior!=null && s.distance()>DISENGAGE) {
                // We can see it, and we have left it well behind. Occlusion memory exists for
                // things we lost sight of, not for keeping a retreat alive out to the horizon.
                memory.remove(s.id());
            } else if(prior!=null && tick-prior.confirmed()<=MEMORY_TICKS
                    && s.distance()<=(s.airborneOrRanged()?ENGAGE_RANGED:DISENGAGE)) {
                // Occlusion is uncertainty, not immediate safety; current coordinates remain client-known.
                threats.add(new Evidence(s,"recent pursuit; evidence decaying",tick-prior.confirmed()));
            }
        }
        for(var entry:memory.entrySet()) if(!present.contains(entry.getKey()) && tick-entry.getValue().confirmed()<=MEMORY_TICKS) {
            Seen old=entry.getValue().seen();
            Seen hidden=new Seen(old.id(),old.type(),old.x(),old.y(),old.z(),old.distance(),false,false,
                old.hostile(),old.airborneOrRanged(),false,false,false,false,old.meleeSupported(),old.fast(),old.health());
            threats.add(new Evidence(hidden,"entity no longer observed; last known position, evidence decaying",tick-entry.getValue().confirmed()));
        }
        memory.entrySet().removeIf(e->tick-e.getValue().confirmed()>MEMORY_TICKS);
        threats.sort(Comparator.comparingDouble(e->e.entity().distance()));

        if(threats.isEmpty()) {
            boolean settling=episode && ++quiet<CLEAR_TICKS;
            List<Evidence> quarantine=repeatedSites.values().stream()
                .map(s->new Evidence(s,"repeated worksite threat; waiting for death or relocation",-1)).toList();
            if(!settling && quarantine.isEmpty()) {episode=false;episodeTicks=responseTicks=0;}
            return new Assessment(List.of(),quarantine,episodeTicks,Double.MAX_VALUE,false,false,settling);
        }
        for(Evidence e:threats) if(e.age()==0) previousEncounters.put(e.entity().id(),new Memory(e.entity(),tick));
        double nearest=threats.getFirst().entity().distance();
        if(!episode) startNearest=nearest;
        episode=true;quiet=0;episodeTicks++;responseTicks++;
        // A fresh attack changes the situation. Renew the bounded window rather than releasing the
        // job or opening a second preemption, and never freeze while something is landing hits.
        if(observations.stream().anyMatch(Seen::damagedUs)) {responseTicks=0;lastAttack=tick;startNearest=nearest;}
        // If several seconds of response have not opened up separation, moving away is not working.
        boolean losingGround=episodeTicks>=STALLED_TICKS && nearest<startNearest+STALLED_GAIN;
        List<Evidence> quarantine=repeatedSites.values().stream()
            .map(s->new Evidence(s,"repeated worksite threat; waiting for death or relocation",-1)).toList();
        return new Assessment(List.copyOf(threats),quarantine,episodeTicks,nearest,losingGround,
            responseTicks>MOTION_BUDGET,false);
    }

    /**
     * Choose between working, fighting, retreating and holding.
     *
     * Fighting is a numeric judgement (see {@link Combat}), not a type whitelist, and it is
     * preferred over retreat whenever the arithmetic says we win with health to spare: repeatedly
     * walking away from something that follows us is what produced the recorded preempt/resume
     * loop. Retreat is for what we cannot beat. Holding is the honest answer when neither works.
     */
    /** How long a chosen response is kept before the alternative is reconsidered. */
    static final int COMMIT_TICKS=15;
    private String committed="";
    private int committedAt=-1000;

    Decision respond(Assessment a, double health, Combat.Loadout loadout, boolean escapeAvailable) {
        Decision decision=choose(a,health,loadout,escapeAvailable);
        // A fight abandoned every other tick lands no hits. Once we commit to swinging, keep
        // swinging while the target is still in front of us: the flapping between fight, hold and
        // retreat was the difference between killing a zombie and being killed by it. The
        // commitment lapses when the target is gone, when it primes, or when the window expires.
        boolean stillThere=a.threats().stream().anyMatch(e->e.age()==0 && e.entity().visible()
            && e.entity().distance()<=ENGAGE_MELEE && !e.entity().primed());
        if(decision.mode().equals("fight")) {committed="fight";committedAt=tick;return decision;}
        if(committed.equals("fight") && stillThere && tick-committedAt<COMMIT_TICKS
                && !decision.mode().isEmpty() && !decision.mode().equals("kite")
                && !decision.reason().contains("creeper"))
            return new Decision("fight","holding the fight we committed to; "+decision.reason(),a.threats(),a.episodeTicks());
        committed="";
        return decision;
    }

    private Decision choose(Assessment a, double health, Combat.Loadout loadout, boolean escapeAvailable) {
        if(a.threats().isEmpty()) {
            if(a.settling()) return new Decision("hold","waiting for stable clearance",List.of(),a.episodeTicks());
            if(!a.quarantine().isEmpty())
                return new Decision("hold","unchanged worksite threat; clearance alone cannot restart the same job",
                    a.quarantine(),a.episodeTicks());
            return new Decision("","no credible threat; clearance stable",List.of(),0);
        }
        // Everything that can currently reach or shoot us is part of the fight, whether or not we
        // would choose it as a target: a skeleton covering an approaching zombie changes the answer.
        // Hysteresis on the boundary: something engaged last tick stays engaged a little further
        // out, or a mob hovering at exactly the radius flips the whole response every tick.
        Set<String> stillEngaged=new HashSet<>();
        List<Combat.Target> engaged=a.threats().stream()
            .filter(e->e.age()==0 && e.entity().visible() && !e.entity().primed())
            .filter(e->{
                double slack=engagedIds.contains(e.entity().id())?2:0;
                boolean in=e.entity().airborneOrRanged()
                    ? e.entity().distance()<=ENGAGE_RANGED+slack
                    : e.entity().accessible() && e.entity().distance()<=ENGAGE_MELEE+slack;
                if(in) stillEngaged.add(e.entity().id());
                return in;
            })
            // Something flying only counts as fightable within reach: we cannot chase it, so at
            // range it is an unanswerable threat and the whole engagement is a withdrawal.
            .map(e->new Combat.Target(strip(e.entity().type()),e.entity().health(),
                !e.entity().airborneOrRanged() || e.entity().distance()<=CONTACT))
            .toList();
        engagedIds=stillEngaged;
        boolean primed=a.threats().stream().anyMatch(e->e.entity().primed());
        Combat.Plan plan=primed?new Combat.Plan(false,false,0,0,"primed creeper: never trade hits")
            :Combat.plan(engaged,health,loadout);

        if(plan.winnable())
            return new Decision("fight","fight: "+plan.why(),a.threats(),a.episodeTicks());
        // Retreat has stopped paying for itself: either nothing faster than us can be outrun, or
        // several seconds of movement produced no separation, or the movement budget is spent.
        boolean retreatStalled=a.losingGround() || a.budgetExhausted()
            || (escapeAvailable && a.nearest()<=CONTACT
                && a.threats().stream().anyMatch(e->e.age()==0 && e.entity().fast()));
        if(retreatStalled && plan.allFightable() && loadout.enabled() && health>=Combat.minCorneredHealth(loadout.maxHealth()))
            return new Decision("fight","fight because withdrawal is not working ("
                +(a.budgetExhausted()?"movement budget spent":a.losingGround()?"no separation gained":"target outruns a sprint")
                +"): "+plan.why(),a.threats(),a.episodeTicks());
        if(escapeAvailable && !a.budgetExhausted())
            return new Decision("retreat","withdraw from "+a.threats().getFirst().entity().type()
                +" at "+String.format(Locale.ROOT,"%.1f",a.nearest())+"m; "+plan.why(),a.threats(),a.episodeTicks());
        // Cornered. Standing still is not a survival strategy: if we cannot leave and something
        // that is not an explosion is in reach, hit it. Winnable or not, an unfavourable fight
        // beats being hit for free -- observed live, the response held while three zombies killed
        // it, twice. Only a primed creeper is worth not swinging at, because nothing we can do in
        // the time available changes that outcome.
        boolean explosive=engaged.stream().anyMatch(t->Combat.burst(t.type()))
            || a.threats().stream().anyMatch(e->e.entity().primed());
        if(!engaged.isEmpty() && !explosive && a.nearest()<=ENGAGE_MELEE)
            return new Decision("fight","cornered, so fighting whether or not it is favourable: "+plan.why(),
                a.threats(),a.episodeTicks());
        // Nothing to swing at and nowhere planned to run. Standing still is still the worst
        // answer available: give ground while facing whatever is closest. A creeper that cannot
        // close cannot detonate on us, and backing away needs no route -- one checked step at a
        // time, which is exactly what is left when the route search has nothing to offer.
        if(a.nearest()<=KITE_RANGE)
            return new Decision("kite",(explosive?"backing away from an explosion":"giving ground")
                +" at "+String.format(Locale.ROOT,"%.1f",a.nearest())+"m; "+plan.why(),a.threats(),a.episodeTicks());
        return new Decision("hold",escapeAvailable
            ?"response budget exhausted and nothing within reach; work stays suspended"
            :"no escape route, and nothing close enough to give ground from; work stays suspended",
            a.threats(),a.episodeTicks());
    }

    /** Convenience for the regression harness: one tick, both stages. */
    Decision update(List<Seen> observations, double health, Combat.Loadout loadout, boolean escapeAvailable) {
        return respond(assess(observations),health,loadout,escapeAvailable);
    }
    private static String strip(String type) {
        int cut=type.indexOf(':');
        return cut<0?type:type.substring(cut+1);
    }

    // Deliberately explicit: Enemy also includes conditional/harmless entities. Unknown types
    // require observed aggression + approach or attributed damage, never blanket Enemy membership.
    static boolean hostile(String type) {
        return Set.of("zombie","husk","drowned","zombie_villager","skeleton","stray","bogged",
            "wither_skeleton","creeper","cave_spider","silverfish","endermite","witch","pillager","vindicator",
            "evoker","ravager","vex","blaze","ghast","guardian","elder_guardian","phantom",
            "hoglin","zoglin","piglin_brute","wither","ender_dragon","magma_cube").contains(type);
    }
    static boolean airborneOrRanged(String type) {
        return Set.of("skeleton","stray","bogged","pillager","witch","blaze","ghast","guardian",
            "elder_guardian","wither","ender_dragon","evoker","drowned","phantom","vex").contains(type);
    }
    /** Kept as the observation-side label; the fight/flee judgement itself lives in Combat. */
    static boolean meleeSupported(String type) { return Combat.fightable(type); }
}

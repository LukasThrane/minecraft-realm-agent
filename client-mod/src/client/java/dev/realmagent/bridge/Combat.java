package dev.realmagent.bridge;

import java.util.*;

/**
 * Vanilla combat arithmetic. Pure tables and estimates: no game classes, no client state.
 *
 * The point of this class is that "should we fight?" is a numeric question, not a type whitelist.
 * A stone sword against one spider and a stone sword against three zombies are different
 * situations, and the policy should be able to tell them apart from health, armour, weapon and
 * the observed set of attackers rather than from a hand-tuned exception list.
 *
 * Numbers are vanilla normal-difficulty values. They are estimates used to rank options, not a
 * simulation: enchantments, potion effects, knockback, mob pathing and hurt-immunity timing all
 * move the true outcome. Everything is deliberately conservative and the reserve below absorbs
 * the error.
 */
final class Combat {
    /** What we can bring to a fight. `enabled` is the capability gate, not a preference. */
    record Loadout(String weapon, double weaponDps, double armor, boolean canSprint, boolean enabled, double maxHealth) {
        Loadout(String weapon, double weaponDps, double armor, boolean canSprint, boolean enabled) {
            this(weapon, weaponDps, armor, canSprint, enabled, 20);
        }
    }
    /**
     * One thing that would be in the fight. `reachable` is false for something we cannot bring a
     * sword to -- a phantom still circling, a mob across a gap -- which makes the whole engagement
     * unwinnable however weak that mob is, because we have no answer to it at all.
     */
    record Target(String type, double health, boolean reachable) {
        Target(String type, double health) { this(type, health, true); }
    }
    record Plan(boolean winnable, boolean allFightable, double expectedDamage, double seconds, String why) {}

    /**
     * Health kept in hand for the errors above: never plan a fight that ends at zero. Thresholds
     * are fractions of our actual maximum, not absolute hearts -- a world where the player has 44
     * maximum health was happily starting fights at 11, which is a quarter of the bar.
     */
    static final double RESERVE_FRACTION = 0.2, FIGHT_FRACTION = 0.4, CORNERED_FRACTION = 0.25;
    static double reserve(double maxHealth) { return Math.max(4, maxHealth * RESERVE_FRACTION); }
    static double minFightHealth(double maxHealth) { return Math.max(8, maxHealth * FIGHT_FRACTION); }
    static double minCorneredHealth(double maxHealth) { return Math.max(6, maxHealth * CORNERED_FRACTION); }
    private Combat() {}

    static Loadout unarmed() { return new Loadout("fists", dps("fists"), 0, false, false, 20); }

    /** Vanilla armour reduction, ignoring toughness and enchantments (both only help us). */
    static double armorMultiplier(double armor) { return 1 - Math.min(20, Math.max(0, armor)) / 25.0; }

    private static final Map<String,Double> TIER =
        Map.of("wooden",0.0,"golden",0.0,"stone",1.0,"iron",2.0,"diamond",3.0,"netherite",4.0);

    /** Melee damage of a hotbar item, or 0 if it is not a weapon we know how to swing. */
    static double damage(String item) {
        if (item.equals("fists")) return 1;
        if (item.equals("trident")) return 9;
        if (item.equals("mace")) return 6;
        int cut = item.indexOf('_');
        if (cut < 0) return 0;
        Double tier = TIER.get(item.substring(0, cut));
        if (tier == null) return 0;
        return switch (item.substring(cut + 1)) {
            case "sword" -> 4 + tier;
            // Axes do not follow the tier formula in vanilla; wood and gold share a value.
            case "axe" -> item.startsWith("netherite") ? 10 : item.startsWith("wooden") || item.startsWith("golden") ? 7 : 9;
            case "pickaxe" -> 2 + tier;
            case "shovel" -> 2.5 + tier;
            case "hoe" -> 1;
            default -> 0;
        };
    }
    private static double speed(String item) {
        if (item.equals("fists")) return 4;
        if (item.equals("trident")) return 1.1;
        if (item.equals("mace")) return 0.6;
        if (item.endsWith("_sword")) return 1.6;
        if (item.endsWith("_axe")) return item.startsWith("wooden") || item.startsWith("stone") ? 0.8
            : item.startsWith("iron") ? 0.9 : 1.0;
        if (item.endsWith("_pickaxe")) return 1.2;
        return 1.0;
    }
    /**
     * Sustained damage per second. Capped at two hits per second because a mob is invulnerable
     * for ten ticks after being hit, so a fast weak weapon cannot convert its swing rate into
     * damage. This is what stops bare fists from looking like a viable weapon.
     */
    static double dps(String item) {
        double damage = damage(item);
        return damage <= 0 ? 0 : damage * Math.min(speed(item), 2.0);
    }

    /**
     * Damage that lands once rather than every second: an explosion is not a damage race, and
     * charging it per second produced estimates like "159 damage over 6.6s" that are arithmetic
     * noise rather than a judgement.
     */
    static boolean burst(String type) {
        return type.equals("creeper");
    }
    /** Incoming damage per second from one mob at contact, normal difficulty. */
    static double threatDps(String type) {
        Double known = THREAT_DPS.get(type);
        return known != null ? known : 4;
    }
    private static final Map<String,Double> THREAT_DPS = Map.ofEntries(
        Map.entry("zombie",3.0), Map.entry("husk",3.0), Map.entry("zombie_villager",3.0),
        Map.entry("drowned",3.0), Map.entry("spider",2.0), Map.entry("cave_spider",3.0),
        Map.entry("silverfish",1.0), Map.entry("endermite",2.0), Map.entry("slime",2.0),
        Map.entry("magma_cube",4.0), Map.entry("wolf",4.0), Map.entry("skeleton",3.0),
        Map.entry("stray",3.0), Map.entry("bogged",3.0), Map.entry("pillager",3.5),
        Map.entry("vindicator",9.0), Map.entry("evoker",6.0), Map.entry("vex",4.5),
        Map.entry("witch",6.0), Map.entry("blaze",6.0), Map.entry("ghast",6.0),
        Map.entry("guardian",4.5), Map.entry("elder_guardian",8.0), Map.entry("phantom",2.0),
        Map.entry("hoglin",5.0), Map.entry("zoglin",6.0), Map.entry("piglin",5.0),
        Map.entry("piglin_brute",9.0), Map.entry("ravager",12.0), Map.entry("creeper",22.0),
        Map.entry("iron_golem",15.0), Map.entry("enderman",7.0), Map.entry("warden",30.0),
        Map.entry("wither",8.0), Map.entry("ender_dragon",10.0), Map.entry("breeze",3.0),
        Map.entry("polar_bear",4.0), Map.entry("panda",4.0), Map.entry("goat",2.0), Map.entry("llama",1.0));

    /**
     * Mobs this baseline is willing to trade hits with. Excluded on purpose: creepers (the
     * explosion is not a damage race), anything ranged or flying (we have no ranged answer and
     * cannot reach it), group-aggro mobs like zombified piglins, and anything whose loss is
     * unrecoverable — golems, brutes, ravagers, bosses.
     */
    static boolean fightable(String type) {
        return Set.of("zombie","husk","zombie_villager","spider","cave_spider","silverfish",
            "endermite","slime","wolf","vindicator","phantom").contains(type);
    }
    /**
     * Mobs at least as fast as a sprinting player. Retreating from these on foot does not create
     * separation, which is exactly the loop the recorded spider episode was stuck in.
     */
    static boolean outrunsUs(String type) {
        return Set.of("spider","cave_spider","wolf","vex","phantom","ravager","hoglin","zoglin",
            "warden","blaze","ghast","breeze","vindicator","piglin_brute").contains(type);
    }

    /**
     * Estimate the cost of clearing `targets`. Kills run weakest-first and everything still alive
     * keeps hitting us, so three weak mobs cost far more than one tough one with the same total
     * health. A half-second of exposure is added for closing the distance and the first swing.
     */
    static Plan plan(List<Target> targets, double health, Loadout loadout) {
        if (!loadout.enabled()) return new Plan(false, false, 0, 0, "melee capability disabled");
        if (targets.isEmpty()) return new Plan(false, false, 0, 0, "no engaged target");
        boolean allFightable = targets.stream().allMatch(t -> fightable(t.type()) && t.reachable());
        double ourDps = loadout.weaponDps();
        if (ourDps <= 0) return new Plan(false, allFightable, 0, 0, "no usable weapon");
        double incoming = targets.stream().filter(t -> !burst(t.type())).mapToDouble(t -> threatDps(t.type())).sum();
        double damage = incoming * 0.5 + targets.stream().filter(t -> burst(t.type())).mapToDouble(t -> threatDps(t.type())).sum();
        double seconds = 0.5;
        for (Target target : targets.stream().sorted(Comparator.comparingDouble(Target::health)).toList()) {
            double kill = Math.max(0.1, target.health()) / ourDps;
            damage += incoming * kill;
            if (!burst(target.type())) incoming -= threatDps(target.type());
            seconds += kill;
        }
        damage *= armorMultiplier(loadout.armor());
        boolean winnable = allFightable && health >= minFightHealth(loadout.maxHealth())
            && damage <= health - reserve(loadout.maxHealth());
        String why = String.format(Locale.ROOT, "%d target(s), %s %.1f dps, est. %.1f damage over %.1fs against %.0f/%.0f hp",
            targets.size(), loadout.weapon(), ourDps, damage, seconds, health, loadout.maxHealth());
        return new Plan(winnable, allFightable, damage, seconds, why);
    }
}

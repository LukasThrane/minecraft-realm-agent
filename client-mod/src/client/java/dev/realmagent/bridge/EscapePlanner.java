package dev.realmagent.bridge;

import java.util.*;

/**
 * Bounded local route search. The adapter supplies swept body clearance, support and drops.
 *
 * Cells are integer offsets from the player's current position, including a vertical component:
 * real escapes go up a step or down off a ledge far more often than they run across a flat plane,
 * and a strictly flat search is why the recorded retreat could only shuffle sideways.
 */
final class EscapePlanner {
    record Cell(int x,int y,int z) {}
    record Threat(double x,double y,double z) {}
    interface Terrain { boolean edge(Cell from,Cell to); }
    record Route(List<Cell> steps, double clearance) {}

    /** Step-up is one block; drops are limited to a height vanilla survives without damage. */
    private static final int[] LEVELS={0,1,-1,-2,-3};
    static final int MAX_CLIMB=3;
    /** Hard ceiling on search work, so a cave system cannot make a client tick expensive. */
    static final int MAX_CELLS=600;

    static Map<Cell,List<Cell>> reachable(Terrain terrain,int radius) {
        Cell start=new Cell(0,0,0);
        Map<Cell,List<Cell>> paths=new LinkedHashMap<>();paths.put(start,List.of());
        ArrayDeque<Cell> queue=new ArrayDeque<>();queue.add(start);
        while(!queue.isEmpty()) {
            Cell from=queue.remove();
            // One neighbour per direction: take the flattest step that works and stop. Trying every
            // level in every direction multiplies the swept-geometry checks on the client tick for
            // routes that are almost always redundant with the flat one.
            for(int[] d:new int[][]{{1,0},{0,1},{-1,0},{0,-1}}) for(int dy:LEVELS) {
                Cell to=new Cell(from.x()+d[0],from.y()+dy,from.z()+d[1]);
                if(Math.abs(to.x())>radius || Math.abs(to.z())>radius || Math.abs(to.y())>MAX_CLIMB) continue;
                if(paths.containsKey(to)) break;
                if(!terrain.edge(from,to)) continue;
                List<Cell> path=new ArrayList<>(paths.get(from));path.add(to);paths.put(to,List.copyOf(path));queue.add(to);
                break;
            }
            if(paths.size()>=MAX_CELLS) break;
        }
        return paths;
    }

    static Route choose(Map<Cell,List<Cell>> paths,List<Threat> threats) {
        if(threats.isEmpty()) return null;
        double start=clearance(new Cell(0,0,0),threats),best=0;
        Route selected=null;
        for(var entry:paths.entrySet()) {
            List<Cell> path=entry.getValue();
            if(path.isEmpty()) continue;
            double end=clearance(entry.getKey(),threats);
            // A detour may initially travel sideways, but cannot close into the attacker.
            if(end<start+0.5 || path.stream().anyMatch(c->clearance(c,threats)<start-1.5)) continue;
            double score=end-start-0.15*path.size();
            if(score>best) {best=score;selected=new Route(path,end);}
        }
        return selected;
    }

    /**
     * Furthest step on the route we can head straight for. Steering at the next grid cell is what
     * produced cardinal-only, tick-by-tick zig-zag movement; aiming at the furthest step that is
     * still a valid straight line turns the same path into a smooth continuous heading.
     */
    static Cell lookahead(List<Cell> steps,Terrain terrain) {
        Cell from=new Cell(0,0,0), aim=steps.getFirst();
        for(int i=1;i<steps.size() && i<MAX_LOOKAHEAD;i++) {
            Cell candidate=steps.get(i);
            if(candidate.y()!=aim.y() || !terrain.edge(from,candidate)) break;
            aim=candidate;
        }
        return aim;
    }
    private static final int MAX_LOOKAHEAD=6;

    private static double clearance(Cell cell,List<Threat> threats) {
        return threats.stream().mapToDouble(t->
            Math.sqrt(Math.pow(cell.x()-t.x(),2)+Math.pow(cell.y()-t.y(),2)+Math.pow(cell.z()-t.z(),2))).min().orElse(0);
    }
}

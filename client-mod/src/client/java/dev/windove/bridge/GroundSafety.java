package dev.windove.bridge;

/**
 * Swept ground movement used by the live adapter and by the voxel regression fixtures.
 *
 * A step is walkable if the body can be swept along it without clipping geometry or touching a
 * contact hazard. Level steps additionally require support the whole way, so the search cannot
 * route through a one-block hole; a step up is allowed to leave the ground because we jump it,
 * and a drop is allowed to fall as far as vanilla survives unharmed.
 */
final class GroundSafety {
    record Box(double minX,double minY,double minZ,double maxX,double maxY,double maxZ) {
        Box move(double x,double y,double z) {return new Box(minX+x,minY+y,minZ+z,maxX+x,maxY+y,maxZ+z);}
    }
    interface World {
        boolean clear(Box box);
        boolean hazardous(int x,int y,int z);
    }
    /** Maximum safe fall in a single step; four blocks is where vanilla starts dealing damage. */
    static final int MAX_DROP=3;

    static boolean edge(World world,Box body,double fromX,double fromY,double fromZ,
                        double toX,double toY,double toZ) {
        int climb=(int)Math.round(toY-fromY);
        if(climb>1 || climb< -MAX_DROP) return false;
        double travelY=Math.max(fromY,toY);
        int samples=Math.max(4,(int)Math.ceil(Math.hypot(toX-fromX,toZ-fromZ)*4));
        for(int i=0;i<=samples;i++) {
            Box box=body.move(fromX+(toX-fromX)*i/samples,travelY,fromZ+(toZ-fromZ)*i/samples);
            if(!world.clear(box) || touchesHazard(world,box)) return false;
            // A level walk must stay on the ground for its whole length; a jump or a drop may not.
            if(climb==0 && !supported(world,box)) return false;
        }
        Box landing=body.move(toX,toY,toZ);
        if(!world.clear(landing) || touchesHazard(world,landing) || !supported(world,landing)) return false;
        for(double y=toY;y<travelY;y++) {
            Box falling=body.move(toX,y,toZ);
            if(!world.clear(falling) || touchesHazard(world,falling)) return false;
        }
        return true;
    }

    /** Flat convenience used where the caller already knows the step keeps its level. */
    static boolean edge(World world,Box body,double fromX,double fromZ,double toX,double toZ) {
        return edge(world,body,fromX,0,fromZ,toX,0,toZ);
    }

    private static boolean touchesHazard(World world,Box box) {
        for(int x=(int)Math.floor(box.minX());x<=Math.floor(box.maxX());x++)
            for(int y=(int)Math.floor(box.minY()-0.1);y<=Math.floor(box.maxY());y++)
                for(int z=(int)Math.floor(box.minZ());z<=Math.floor(box.maxZ());z++)
                    if(world.hazardous(x,y,z)) return true;
        return false;
    }
    /** Every corner needs floor: standing on a lip is not somewhere we ask the body to walk. */
    private static boolean supported(World world,Box box) {
        for(double x:new double[]{box.minX()+0.01,box.maxX()-0.01})
            for(double z:new double[]{box.minZ()+0.01,box.maxZ()-0.01})
                if(world.clear(new Box(x-0.005,box.minY()-0.15,z-0.005,x+0.005,box.minY(),z+0.005))) return false;
        return true;
    }
}

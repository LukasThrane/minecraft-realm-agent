package dev.realmagent.bridge;

/** Conservative short-horizon contact check, independent of pathfinder cost preferences. */
final class ContactHazards {
    interface World { boolean hazardous(int x,int y,int z); }
    static boolean projected(World world,GroundSafety.Box body,double dx,double dy,double dz) {
        for(int step=0;step<=4;step++) {
            var box=body.move(dx*step,dy*step,dz*step);
            for(int x=(int)Math.floor(box.minX()-0.12);x<=Math.floor(box.maxX()+0.12);x++)
                for(int y=(int)Math.floor(box.minY()-0.1);y<=Math.floor(box.maxY());y++)
                    for(int z=(int)Math.floor(box.minZ()-0.12);z<=Math.floor(box.maxZ()+0.12);z++)
                        if(world.hazardous(x,y,z)) return true;
        }
        return false;
    }
}

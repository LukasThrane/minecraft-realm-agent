package dev.windove.bridge;

import baritone.api.BaritoneAPI;
import baritone.api.pathing.goals.GoalXZ;
import com.google.gson.*;
import com.sun.net.httpserver.*;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import org.lwjgl.glfw.GLFW;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * Tick-owned control and loopback transport, including skills and bounded defensive survival.
 *
 * Observation (protocol 2) is strictly read-only and lives beside control, not inside it:
 * /observe and /frame cannot start, steer or extend an action. Both are sampled on the tick
 * only while something is asking, and both report their own age so a slow planner can tell
 * that what it is looking at has already expired.
 */
public final class BridgeClient implements ClientModInitializer {
    private final Gson gson = new Gson();
    private final AtomicLong epoch = new AtomicLong();
    private final AtomicReference<JsonObject> pending = new AtomicReference<>();
    private final AtomicReference<byte[]> frameBytes = new AtomicReference<>();
    private final AtomicBoolean captureInFlight = new AtomicBoolean();
    private final AtomicBoolean stopRequested = new AtomicBoolean();
    private volatile long leaseUntil;
    private volatile String snapshot = "{\"online\":false}";
    private volatile String observation = "{\"online\":false}";
    private volatile long observedWantedUntil, observationAt, frameWantedUntil, frameAt, captureStartedAt;
    private volatile int frameWidth, frameHeight;
    private volatile String frameError = "";
    private Path framePath;
    private volatile String session = UUID.randomUUID().toString();
    private String token, phase="idle", reason="Ready", actionId="";
    private Object playerIdentity;
    private boolean navigating, wasF8, respawning, wasDead;
    private volatile boolean dead, onDeathScreen, hardcore;
    private volatile String deathMessage = "";
    private volatile long lastRespawnAt, lastDeathAt;
    private volatile int deaths;
    private int targetX, targetZ, arrivalTicks;
    private long started, lastMovement, deadlineMs;
    private double lastX, lastZ;
    private String activeType="", moveDirection="";
    private int actionTicksLeft;
    private Skills skill;
    private boolean leftGround;
    private double peakY;
    private JsonObject beforeSnapshot=new JsonObject(), assumes;
    private final Progress progress=new Progress();
    /** Always-on history: it has to already exist when something asks what just happened. */
    private static final int HISTORY_SAMPLES=60, HISTORY_EVERY_TICKS=10;
    private final ArrayDeque<JsonObject> history=new ArrayDeque<>();
    private volatile String historyView="[]";
    private String failure=Actions.FAIL_NONE;
    private volatile boolean reflexArmed;
    private volatile String activeReflex=Reflexes.NONE;
    private volatile int reflexCount;
    private int reflexTicks;
    private final Survival survival=new Survival();
    private final Loadout loadout=new Loadout();
    private final ArrayDeque<JsonObject> survivalEvents=new ArrayDeque<>();
    private int reflexSlot=-1;
    private String survivalLogKey="";
    private volatile String lastControllerError="", survivalError="";
    private volatile boolean stopKeepsSafety;
    private BlockPos targetPos; private Direction targetFace;
    private String targetBlockBefore="", targetBlockAfter="";
    private volatile boolean singleplayer;
    private Minecraft client;
    private volatile String outcome="{}";
    private volatile long ticks, stopReceivedTick=-1, stopReceivedAt, stopReleaseTicks=-1, stopReleaseMs=-1, maxStopReleaseTicks, stopReleaseAt;
    private HttpServer server;
    private ExecutorService executor;

    @Override public void onInitializeClient() {
        try {
            Path tokenPath = Minecraft.getInstance().gameDirectory.toPath().resolve("config/windove-bridge-token.txt");
            Files.createDirectories(tokenPath.getParent());
            if (!Files.exists(tokenPath)) {
                Files.writeString(tokenPath, UUID.randomUUID()+"-"+UUID.randomUUID(), StandardOpenOption.CREATE_NEW);
                try { Files.setPosixFilePermissions(tokenPath, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")); } catch (UnsupportedOperationException ignored) {}
            }
            token = Files.readString(tokenPath).trim();
            if (token.length()<32) throw new IllegalStateException("Bridge token must be at least 32 characters");
            framePath = Minecraft.getInstance().gameDirectory.toPath().resolve("windove-frames/latest.png");
            Files.createDirectories(framePath.getParent());
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 3009), 8);
            // Observation requests park briefly waiting for the next tick; keep control polling unblocked.
            executor = Executors.newFixedThreadPool(4, r -> { Thread t=new Thread(r,"windove-http");t.setDaemon(true);return t; });
            server.setExecutor(executor);
            server.createContext("/", this::handle);
            server.start();
            ClientTickEvents.START_CLIENT_TICK.register(this::tick);
            ClientLifecycleEvents.CLIENT_STOPPING.register(mc -> { halt("Client closing"); server.stop(0); executor.shutdownNow(); });
            System.out.println("Windove bridge on 127.0.0.1:3009; token file: "+tokenPath+"; F8 stops control");
        } catch (Exception e) { throw new IllegalStateException("Cannot initialize Windove bridge",e); }
    }
    private void reply(HttpExchange ex, int status, String body) throws java.io.IOException {
        replyBytes(ex,status,"application/json",body.getBytes(StandardCharsets.UTF_8));
    }
    private void replyBytes(HttpExchange ex, int status, String type, byte[] bytes) throws java.io.IOException {
        ex.getResponseHeaders().set("Content-Type",type);
        ex.getResponseHeaders().set("Cache-Control","no-store");
        ex.sendResponseHeaders(status,bytes.length);ex.getResponseBody().write(bytes);ex.close();
    }
    /** Ask the tick for a fresh sample and wait a bounded time for it. Never touches game state. */
    private boolean awaitSample(long requestedAt, long maxWaitMs, java.util.function.LongSupplier sampledAt) {
        long deadline=System.currentTimeMillis()+maxWaitMs;
        while (sampledAt.getAsLong()<requestedAt && System.currentTimeMillis()<deadline) {
            try { Thread.sleep(25); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        }
        return sampledAt.getAsLong()>=requestedAt;
    }
    private void observe(HttpExchange ex) throws java.io.IOException {
        long requestedAt=System.currentTimeMillis();
        observedWantedUntil=requestedAt+5000;
        boolean fresh=awaitSample(requestedAt,500,()->observationAt);
        JsonObject view=JsonParser.parseString(observation).getAsJsonObject();
        view.addProperty("protocol",3);view.addProperty("session",session);view.addProperty("epoch",epoch.get());
        view.addProperty("observedAt",observationAt);view.addProperty("ageMs",System.currentTimeMillis()-observationAt);
        view.addProperty("fresh",fresh);view.addProperty("positionSource","client-predicted");
        reply(ex,200,gson.toJson(view));
    }
    private void frame(HttpExchange ex) throws java.io.IOException {
        long requestedAt=System.currentTimeMillis();
        frameWantedUntil=requestedAt+5000;
        boolean fresh=awaitSample(requestedAt,1500,()->frameAt);
        byte[] bytes=frameBytes.get();
        if (bytes==null) {
            // A frame only exists once the render thread has produced one; say so rather than stalling.
            reply(ex,503,gson.toJson(Map.of("error","No frame captured yet","frameError",frameError)));return;
        }
        ex.getResponseHeaders().set("X-Windove-Captured-At",String.valueOf(frameAt));
        ex.getResponseHeaders().set("X-Windove-Age-Ms",String.valueOf(System.currentTimeMillis()-frameAt));
        ex.getResponseHeaders().set("X-Windove-Fresh",String.valueOf(fresh));
        ex.getResponseHeaders().set("X-Windove-Width",String.valueOf(frameWidth));
        ex.getResponseHeaders().set("X-Windove-Height",String.valueOf(frameHeight));
        ex.getResponseHeaders().set("X-Windove-Session",session);
        replyBytes(ex,200,"image/png",bytes);
    }
    private void handle(HttpExchange ex) throws java.io.IOException {
        try {
            String auth=ex.getRequestHeaders().getFirst("Authorization");
            if (ex.getRequestHeaders().getFirst("Origin")!=null || auth==null || !MessageDigest.isEqual(auth.getBytes(StandardCharsets.UTF_8),("Bearer "+token).getBytes(StandardCharsets.UTF_8))) {
                reply(ex,403,"{\"error\":\"Forbidden\"}");return;
            }
            String path=ex.getRequestURI().getPath();
            if (ex.getRequestMethod().equals("GET")) {
                if (path.equals("/state")) {JsonObject view=JsonParser.parseString(snapshot).getAsJsonObject(); view.addProperty("stopPending",stopRequested.get()); reply(ex,200,gson.toJson(view));return;}
                if (path.equals("/observe")) {observe(ex);return;}
                if (path.equals("/frame")) {frame(ex);return;}
                if (path.equals("/history")) {
                    JsonObject view=new JsonObject();
                    view.addProperty("protocol",3);view.addProperty("session",session);view.addProperty("tick",ticks);
                    view.addProperty("intervalTicks",HISTORY_EVERY_TICKS);view.addProperty("spanTicks",HISTORY_SAMPLES*HISTORY_EVERY_TICKS);
                    view.add("samples",JsonParser.parseString(historyView));
                    reply(ex,200,gson.toJson(view));return;
                }
            }
            if (!ex.getRequestMethod().equals("POST")) {reply(ex,405,"{}");return;}
            byte[] raw=ex.getRequestBody().readNBytes(4097);
            if(raw.length>4096) {reply(ex,413,"{}");return;}
            if(path.equals("/stop")) {
                // `keepSafety` marks a stop the agent issued to cancel its own job. An operator
                // stop still switches the safety tier off; a retarget must not.
                stopKeepsSafety=raw.length>0
                    && JsonParser.parseString(new String(raw,StandardCharsets.UTF_8)).getAsJsonObject()
                        .has("keepSafety");
                // Record the tick we were heard on; the tick that releases inputs reports the gap.
                stopReceivedTick=ticks;stopReceivedAt=System.currentTimeMillis();
                epoch.incrementAndGet(); pending.set(null);stopRequested.set(true);leaseUntil=0;
                reply(ex,200,"{\"accepted\":true}");return;
            }
            JsonObject data=JsonParser.parseString(new String(raw,StandardCharsets.UTF_8)).getAsJsonObject();
            if(!session.equals(data.get("session").getAsString()) || epoch.get()!=data.get("epoch").getAsLong()) {reply(ex,409,"{\"error\":\"Stale session or control epoch\"}");return;}
            if(path.equals("/lease")) {leaseUntil=System.currentTimeMillis()+3000;reply(ex,200,"{}");return;}
            if(path.equals("/reflex")) {
                reflexArmed=data.get("armed").getAsBoolean();
                reply(ex,200,"{\"armed\":"+reflexArmed+"}");return;
            }
            // The single-purpose paths are shims that build the same envelope /act takes, so the
            // existing service keeps working while there is only one way into the tick.
            if(path.equals("/navigate")) {
                JsonObject args=new JsonObject();args.add("x",data.get("x"));args.add("z",data.get("z"));
                envelope(data,"navigate",args,180_000);path="/act";
            } else if(path.equals("/respawn")) {
                envelope(data,"respawn",new JsonObject(),15_000);path="/act";
            }
            if(!path.equals("/act")) {reply(ex,404,"{}");return;}
            Actions.validate(data);
            String type=data.get("type").getAsString();
            if(type.equals("respawn")) {
                if(!dead || !onDeathScreen) {reply(ex,409,"{\"error\":\"Not on the death screen\"}");return;}
                if(hardcore) {reply(ex,409,"{\"error\":\"Hardcore world; respawn is not available\"}");return;}
            }
            // Every action acts on the world we last showed the caller, so every action is fresh-checked.
            long observedAt=data.get("observedAt").getAsLong();
            if(System.currentTimeMillis()-observedAt>2000 || observedAt>System.currentTimeMillis()+1000) {reply(ex,409,"{\"error\":\"Stale observation\"}");return;}
            if(!pending.compareAndSet(null,data)) {reply(ex,409,"{\"error\":\"Command pending\"}");return;}
            leaseUntil=System.currentTimeMillis()+3000;
            reply(ex,202,"{\"accepted\":true}");
        } catch(Exception e) {reply(ex,400,"{\"error\":\"Invalid request\"}");}
    }
    private void envelope(JsonObject data, String type, JsonObject args, long deadlineMs) {
        data.addProperty("type",type);data.add("args",args);
        data.addProperty("scope",Actions.SCOPE_TRAVEL);
        data.addProperty("actionId",data.get("id").getAsString());
        data.addProperty("deadlineMs",deadlineMs);
    }
    /**
     * Low-level movement drives the vanilla key bindings, not Baritone's input override.
     * Baritone clears forced inputs on its own tick while it holds no path, which reduced a
     * one-second walk to roughly a tenth of a block; the gate-1 run measured that directly.
     */
    private static KeyMapping keyFor(Minecraft mc, String direction) {
        return switch (direction) {
            case "back" -> mc.options.keyDown; case "left" -> mc.options.keyLeft;
            case "right" -> mc.options.keyRight; default -> mc.options.keyUp;
        };
    }
    /**
     * Remaining work in each action's own terms, so progress is measured rather than assumed.
     * Lower is closer to done. Passing null args reuses the target already latched at start.
     */
    private double remainingWork(Minecraft mc, String type, JsonObject args) {
        if (mc.player==null) return Double.NaN;
        switch (type) {
            case "navigate" -> {
                int x=args!=null?args.get("x").getAsInt():targetX, z=args!=null?args.get("z").getAsInt():targetZ;
                return Math.hypot(mc.player.getX()-(x+0.5), mc.player.getZ()-(z+0.5));
            }
            case "move" -> { return args!=null?args.get("ticks").getAsInt():actionTicksLeft; }
            case "break" -> { return targetPos!=null && mc.level!=null && mc.level.getBlockState(targetPos).isAir() ? 0 : 1; }
            default -> { return args!=null?1:actionTicksLeft; }
        }
    }
    private void disarm(String why) {
        if(!reflexArmed && activeReflex.equals(Reflexes.NONE)) return;
        reflexArmed=false;endReflex(why);survival.reset();
    }
    private void endReflex(String why) {
        if(activeReflex.equals(Reflexes.NONE)) return;
        logSurvival("end",why);
        activeReflex=Reflexes.NONE;reflexTicks=0;releaseHeldKeys();
        if(client!=null && client.player!=null && reflexSlot>=0) client.player.getInventory().setSelectedSlot(reflexSlot);
        reflexSlot=-1;
        if(phase.equals("reflex")) phase="idle";
        if(client!=null&&client.options!=null) client.options.keyUse.setDown(false);
        reason=why;
    }
    /**
     * The safety tier. Runs before any task work, so it can preempt it, and runs whether or not
     * the agent process is responsive — which is the point: deliberation takes seconds.
     */
    private void logSurvival(String event,String why) {
        JsonObject record=survival.evidence().deepCopy();
        record.addProperty("event",event);record.addProperty("response",activeReflex);
        record.addProperty("why",why);record.addProperty("clientTick",ticks);
        survivalEvents.addLast(record);while(survivalEvents.size()>32) survivalEvents.removeFirst();
        // Published as a bounded event ring; Node journals it asynchronously, never tick-thread disk I/O.
    }
    private void runReflexes(Minecraft mc, boolean f8) {
        if(f8 || !reflexArmed || mc.player==null || dead || (mc.gui.screen()!=null && !(skill!=null && skill.ownsMenu(mc))) || mc.isPaused()) {
            if(!activeReflex.isEmpty() && (dead || mc.gui.screen()!=null || mc.isPaused())) {
                // Cancel the response and the action it preempted, but stay armed. Disarming here
                // meant one death or one opened menu silently switched safety off for the rest of
                // the run, after which a zombie could stand and hit an idle player unopposed.
                // Only the operator (F8, an explicit disarm) or a controller fault turns it off.
                finish("cancelled",Actions.FAIL_TAKEOVER,"Survival cancelled by death/menu/pause",true);
                endReflex("Survival cancelled by death/menu/pause; safety stays armed");
            } else endReflex("Safety tier idle / operator or world unavailable");
            survival.reset();return;
        }
        String threat;
        // A fault in threat assessment must not take the bridge down with it. Survival is the
        // tier that is allowed to fail safe: log it once, drop back to physiological maintenance
        // and keep the body under control, rather than blocking every skill on a stack trace.
        try { threat=survival.update(mc); }
        catch(LinkageError|RuntimeException e) {
            if(survivalError.isEmpty()) org.slf4j.LoggerFactory.getLogger("windove-bridge").error("Survival assessment failed; falling back to maintenance reflexes",e);
            survivalError=e.toString();survival.reset();threat=Reflexes.NONE;
        }
        String wanted;
        // Above everything, including drowning: lava takes about four seconds, and a threat we
        // are retreating from is less urgent than the floor we are standing in.
        // Contact, or one step from it. The task layer's veto stops the body without moving it,
        // which parked a character beside lava for the twenty seconds a review took and killed it.
        // Heading into a hazard is the safety tier's business: it takes the body, walks it clear,
        // and the task suspends resumably instead of dying where it stands.
        if(Reflexes.burning(mc) || Skills.approachingHazard(mc)) wanted=Reflexes.ESCAPE;
        else if(Reflexes.drowning(mc) || activeReflex.equals(Reflexes.SURFACE) && Reflexes.stillNeeded(mc,activeReflex)) wanted=Reflexes.SURFACE;
        else if(!threat.isEmpty()) wanted=threat;
        else if(activeReflex.equals(Reflexes.EAT) && reflexTicks<Reflexes.EAT_MAX_TICKS && Reflexes.stillNeeded(mc,activeReflex)) wanted=Reflexes.EAT;
        else wanted=Reflexes.maintenance(mc);
        if(wanted.isEmpty()) {endReflex("Safety cleared: "+survival.reason());return;}
        String responseWhy=wanted.equals(Reflexes.EAT)?"food below recovery threshold; edible hotbar slot "+Reflexes.foodSlot(mc):
            wanted.equals(Reflexes.SURFACE)?"underwater air recovery; air="+mc.player.getAirSupply():
            wanted.equals(Reflexes.ESCAPE)?(Reflexes.burning(mc)?"standing in a contact hazard; leaving it":"movement leads into a contact hazard; backing off"):survival.reason();
        boolean start=activeReflex.isEmpty();
        if(start) {
            if(!activeType.isEmpty()) finish("cancelled",Actions.FAIL_SAFETY,"Preempted by safety reflex: "+wanted+"; "+responseWhy,false);
            // Safety is the only movement owner even between task actions.
            try {var b=BaritoneAPI.getProvider().getPrimaryBaritone();b.getPathingBehavior().forceCancel();b.getInputOverrideHandler().clearAllKeys();} catch(LinkageError|RuntimeException ignored) {}
            reflexSlot=mc.player.getInventory().getSelectedSlot();reflexTicks=0;reflexCount++;
        }
        boolean changed=!activeReflex.equals(wanted);
        activeReflex=wanted;reflexTicks++;phase="reflex";
        reason="Safety reflex: "+wanted+"; "+responseWhy;
        String logKey=wanted+":"+(wanted.equals(Reflexes.SURFACE)?"air recovery":responseWhy);
        if(start || changed || !logKey.equals(survivalLogKey) || reflexTicks%20==0) {
            logSurvival(start?"start":changed?"transition":"persist",reason);survivalLogKey=logKey;
        }
        releaseHeldKeys();mc.options.keyUse.setDown(false);
        if(wanted.equals(Reflexes.ESCAPE)) survival.escapeHazard(mc);
        else if(wanted.equals(Reflexes.SURFACE)) mc.options.keyJump.setDown(true);
        else if(wanted.equals(Reflexes.EAT)) {
            int slot=Reflexes.foodSlot(mc);
            if(slot>=9 && mc.player.containerMenu==mc.player.inventoryMenu && mc.player.containerMenu.getCarried().isEmpty()) {
                mc.gameMode.handleContainerInput(mc.player.inventoryMenu.containerId,slot,mc.player.getInventory().getSelectedSlot(),net.minecraft.world.inventory.ContainerInput.SWAP,mc.player);
            } else if(slot>=0 && slot<9) {mc.player.getInventory().setSelectedSlot(slot);mc.options.keyUse.setDown(true);}
        } else {
            try { survival.drive(mc); }
            catch(LinkageError|RuntimeException e) {
                if(survivalError.isEmpty()) org.slf4j.LoggerFactory.getLogger("windove-bridge").error("Survival actuation failed; releasing movement",e);
                survivalError=e.toString();releaseHeldKeys();endReflex("Survival actuation failed: "+e.getClass().getSimpleName());
            }
        }
    }
    private static String blockAt(Minecraft mc, BlockPos pos) {
        if (mc.level==null || pos==null) return "";
        return String.valueOf(BuiltInRegistries.BLOCK.getKey(mc.level.getBlockState(pos).getBlock()));
    }
    private void releaseHeldKeys() {
        if (client==null || client.options==null) return;
        for (KeyMapping key : new KeyMapping[]{client.options.keyUp,client.options.keyDown,client.options.keyLeft,client.options.keyRight,client.options.keyJump,client.options.keySprint})
            key.setDown(false);
    }
    /**
     * The plan's gate 2 asks for a movement oracle that is not the client's own prediction.
     * In singleplayer the integrated server has the authoritative position, so publish it
     * alongside the predicted one rather than in place of it. On a Realm there is none, and
     * the state says so instead of implying a server acknowledgement we never received.
     */
    private void publishServerPosition(Minecraft mc, JsonObject state) {
        state.addProperty("serverPositionAvailable",false);
        try {
            if (!mc.hasSingleplayerServer() || mc.player==null) return;
            var server = mc.getSingleplayerServer();
            if (server==null) return;
            var authoritative = server.getPlayerList().getPlayer(mc.player.getUUID());
            if (authoritative==null) return;
            state.addProperty("serverPositionAvailable",true);
            state.addProperty("serverX",authoritative.getX());
            state.addProperty("serverY",authoritative.getY());
            state.addProperty("serverZ",authoritative.getZ());
            state.addProperty("serverDrift",Math.hypot(authoritative.getX()-mc.player.getX(),authoritative.getZ()-mc.player.getZ()));
        } catch (LinkageError|RuntimeException ignored) { }
    }
    private void restrictNavigation() {
        var s=BaritoneAPI.getSettings();
        s.allowBreak.value=false;s.allowBreakAnyway.value=List.of();s.allowPlace.value=false;
        s.allowParkour.value=false;s.allowParkourPlace.value=false;s.allowWaterBucketFall.value=false;
        s.allowInventory.value=false;s.allowSprint.value=true;s.maxFallHeightNoWater.value=2;
        s.assumeWalkOnWater.value=false;s.assumeWalkOnLava.value=false;s.assumeStep.value=false;
        s.rightClickContainerOnArrival.value=false;s.enterPortal.value=false;
        s.chatControl.value=false;s.chatControlAnyway.value=false;s.prefixControl.value=false;
        s.renderPathIgnoreDepth.value=false;s.renderGoalIgnoreDepth.value=false;
        s.avoidance.value=true;s.mobAvoidanceRadius.value=12;
    }
    private void halt(String why) { finish("cancelled", Actions.FAIL_INTERRUPTED, why, true); }
    /**
     * The one exit from an action. status is the plan's vocabulary — succeeded, blocked, cancelled,
     * failed — and every non-success also carries a typed failure class, because free text cannot
     * be matched against a remedy the next time the same thing goes wrong.
     */
    private void finish(String status, String failureClass, String why) { finish(status, failureClass, why, false); }
    /**
     * `changesAuthority` is true only for a real change of control: takeover, stop, world change,
     * death, heartbeat loss. Everything else — an action finishing normally, the agent replacing
     * its own action, a safety reflex borrowing the body — leaves ownership exactly where it was.
     *
     * The epoch was previously bumped on every exit, including ordinary completion. That made a
     * benign race look like a takeover: the agent reads state at epoch E while an action is still
     * running, the action finishes before its next request lands, and the request is rejected as
     * stale. Two seconds of stall, then a retry, over and over — most of a run's wall time.
     */
    private void finish(String status, String failureClass, String why, boolean changesAuthority) {
        failure=status.equals("succeeded")?Actions.FAIL_NONE:failureClass;
        if(!activeType.isEmpty()) {
            if(skill!=null) {skill.close(client);skill=null;}
            try {var b=BaritoneAPI.getProvider().getPrimaryBaritone();b.getPathingBehavior().forceCancel();b.getInputOverrideHandler().clearAllKeys();} catch (LinkageError|RuntimeException ignored) {}
            releaseHeldKeys();
            if(activeType.equals("break") && client!=null && client.gameMode!=null) client.gameMode.stopDestroyBlock();
            JsonObject after=client!=null?Actions.snapshot(client,ticks):new JsonObject();
            JsonObject record=new JsonObject();
            record.addProperty("actionId",actionId);record.addProperty("type",activeType);
            record.addProperty("status",status);record.addProperty("failure",failure);record.addProperty("reason",why);
            record.addProperty("progress",progress.score());record.addProperty("stagnantTicks",progress.stagnantTicks());
            record.addProperty("remaining",progress.remaining());record.addProperty("bestRemaining",progress.best());
            record.addProperty("elapsedMs",System.currentTimeMillis()-started);
            record.add("before",beforeSnapshot);record.add("after",after);
            JsonObject evidence=Actions.evidence(activeType,beforeSnapshot,after,peakY);
            if(activeType.equals("break")||activeType.equals("place")) {
                targetBlockAfter=blockAt(client,activeType.equals("break")?targetPos:(targetPos==null?null:targetPos.relative(targetFace)));
                evidence.addProperty("target",String.valueOf(targetPos));
                evidence.addProperty("blockBefore",targetBlockBefore);evidence.addProperty("blockAfter",targetBlockAfter);
                evidence.addProperty("changed",!targetBlockBefore.equals(targetBlockAfter));
            }
            record.add("evidence",evidence);
            outcome=gson.toJson(record);
        }
        navigating=false;activeType="";actionTicksLeft=0;assumes=null;arrivalTicks=0;reason=why;
        if(changesAuthority) { pending.set(null);epoch.incrementAndGet(); }
        phase=switch(status){case "succeeded"->"succeeded";case "blocked"->"blocked";case "failed"->"failed";default->"stopped";};
    }
    /** Asynchronous GPU readback; the consumer runs later on the render thread. Never blocks a tick. */
    private void capture(Minecraft mc, long now) {
        if (!captureInFlight.compareAndSet(false,true)) return;
        captureStartedAt=now;
        try {
            var target=mc.gameRenderer.mainRenderTarget();
            if (target==null || target.width<=0) { captureInFlight.set(false); return; }
            int downscale=Math.max(1,Math.round(target.width/640f));
            Screenshot.takeScreenshot(target,downscale,image -> {
                try {
                    image.writeToFile(framePath);
                    frameBytes.set(Files.readAllBytes(framePath));
                    frameWidth=image.getWidth();frameHeight=image.getHeight();
                    frameError="";frameAt=System.currentTimeMillis();
                } catch (Exception e) { frameError=e.getClass().getSimpleName()+": "+e.getMessage(); }
                finally { try { image.close(); } catch (RuntimeException ignored) {} captureInFlight.set(false); }
            });
        } catch (LinkageError|RuntimeException e) { frameError=e.getClass().getSimpleName(); captureInFlight.set(false); }
    }
    private void tick(Minecraft mc) {
        try {
            client=mc;ticks++;singleplayer=mc.hasSingleplayerServer();
            long now=System.currentTimeMillis();
            boolean f8=GLFW.glfwGetKey(mc.getWindow().handle(),GLFW.GLFW_KEY_F8)==GLFW.GLFW_PRESS;
            if(f8&&!wasF8) {finish("cancelled",Actions.FAIL_TAKEOVER,"Manual takeover (F8)",true);disarm("Manual takeover (F8)");}
            wasF8=f8;
            dead = mc.player!=null && (mc.player.isDeadOrDying() || mc.player.getHealth()<=0);
            onDeathScreen = mc.gui.screen() instanceof DeathScreen;
            hardcore = mc.level!=null && mc.level.getLevelData().isHardcore();
            if(dead && !wasDead) {
                deaths++;lastDeathAt=now;
                try { deathMessage=mc.player.getCombatTracker().getDeathMessage().getString(); } catch (RuntimeException e) { deathMessage="unknown"; }
            }
            wasDead=dead;
            if(playerIdentity!=mc.player) {
                // Respawning replaces the player entity, so distinguish it from a world change.
                endReflex("World/session changed");survival.reset();survivalEvents.clear();
                Skills.clearPending();loadout.reset();
                halt(respawning?"Respawned":"World/session changed");
                if(respawning) {lastRespawnAt=now;respawning=false;}
                playerIdentity=mc.player;session=UUID.randomUUID().toString();
            }
            if(stopRequested.getAndSet(false)) {
                finish("cancelled",Actions.FAIL_TAKEOVER,"Stop requested",true);
                // Cancelling work is not the same as switching safety off. The agent stops its own
                // job whenever it retargets, and disarming there left the body unprotected until
                // something noticed and re-armed it.
                if(stopKeepsSafety) endReflex("Stop requested; safety stays armed");
                else disarm("Stop requested");
                stopKeepsSafety=false;
                long received=stopReceivedTick;
                if(received>=0) {
                    stopReleaseTicks=ticks-received;stopReleaseMs=System.currentTimeMillis()-stopReceivedAt;stopReleaseAt=System.currentTimeMillis();
                    maxStopReleaseTicks=Math.max(maxStopReleaseTicks,stopReleaseTicks);stopReceivedTick=-1;
                }
            }
            if(!activeType.isEmpty() && !activeType.equals("respawn") && (mc.player==null||dead||(mc.gui.screen()!=null && !(skill!=null && skill.ownsMenu(mc)))||mc.isPaused())) halt(dead?"Player died":"World unavailable, menu opened or paused");
            if(!activeType.isEmpty() && now>leaseUntil) halt("Agent heartbeat lost");
            runReflexes(mc,f8);
            // Keep the kit usable between actions. Armour is no use in a bag and the safety tier
            // only sees the hotbar, so this runs on the tick rather than costing a model decision.
            if(!f8 && reflexArmed && activeReflex.equals(Reflexes.NONE) && activeType.isEmpty()
                    && !dead && mc.gui.screen()==null && !mc.isPaused() && mc.gameMode!=null) {
                String adjusted=loadout.tick(mc);
                if(adjusted!=null) logSurvival("loadout",adjusted);
            }
            // Hold a queued command while the safety tier owns the body; start it when it lets go.
            JsonObject cmd=activeReflex.equals(Reflexes.NONE)?pending.getAndSet(null):null;
            boolean owned=cmd!=null && !f8 && mc.player!=null && cmd.get("epoch").getAsLong()==epoch.get() && cmd.get("session").getAsString().equals(session);
            String requested=owned?cmd.get("type").getAsString():"";
            // Preconditions are revalidated here, at execution time, not trusted from acceptance.
            boolean gameplay=mc.gui.screen()==null && !mc.isPaused() && !dead;
            if(owned && (requested.equals("respawn") || gameplay)) {
                // The agent replacing its own action is not a change of authority.
                finish("cancelled",Actions.FAIL_INTERRUPTED,"Replacing action",false);
                JsonObject args=cmd.getAsJsonObject("args");
                actionId=cmd.get("actionId").getAsString();deadlineMs=cmd.get("deadlineMs").getAsLong();
                beforeSnapshot=Actions.snapshot(mc,ticks);peakY=mc.player.getY();leftGround=false;
                assumes=cmd.has("assumes")?cmd.getAsJsonObject("assumes"):null;
                started=lastMovement=now;activeType=requested;
                progress.reset(remainingWork(mc,requested,args));
                switch(requested) {
                    case "skill" -> {restrictNavigation();skill=new Skills(mc,args);phase="skill";reason="Executing "+args.get("kind").getAsString();}
                    case "navigate" -> {
                        restrictNavigation();
                        targetX=args.get("x").getAsInt();targetZ=args.get("z").getAsInt();
                        lastX=mc.player.getX();lastZ=mc.player.getZ();navigating=true;
                        phase="navigating";reason="Goal submitted; waiting for observed movement";
                        BaritoneAPI.getProvider().getPrimaryBaritone().getCustomGoalProcess().setGoalAndPath(new GoalXZ(targetX,targetZ));
                    }
                    case "move" -> {
                        restrictNavigation();
                        moveDirection=args.get("direction").getAsString();actionTicksLeft=args.get("ticks").getAsInt();
                        phase="moving";reason="Holding "+moveDirection+" for "+actionTicksLeft+" ticks";
                    }
                    case "jump" -> { restrictNavigation();actionTicksLeft=10;phase="jumping";reason="Jumping"; }
                    case "look" -> {
                        boolean relative=args.has("relative") && args.get("relative").getAsBoolean();
                        float yaw=(float)args.get("yaw").getAsDouble(), pitch=(float)args.get("pitch").getAsDouble();
                        mc.player.setYRot(relative?mc.player.getYRot()+yaw:yaw);
                        mc.player.setXRot(Math.max(-90f,Math.min(90f,relative?mc.player.getXRot()+pitch:pitch)));
                        actionTicksLeft=1;phase="looking";reason="Rotation applied";
                    }
                    case "select" -> { mc.player.getInventory().setSelectedSlot(args.get("slot").getAsInt());actionTicksLeft=1;phase="selecting";reason="Hotbar slot selected"; }
                    case "break", "place" -> {
                        // The target is whatever the player is actually looking at, at normal reach.
                        // No coordinate argument, so nothing can be modified out of view.
                        targetPos=null;targetFace=null;targetBlockBefore="";targetBlockAfter="";
                        if(mc.hitResult instanceof BlockHitResult hit && hit.getType()==HitResult.Type.BLOCK) {
                            targetPos=hit.getBlockPos();targetFace=hit.getDirection();
                            if(requested.equals("break")) {
                                targetBlockBefore=blockAt(mc,targetPos);
                                actionTicksLeft=args.get("ticks").getAsInt();
                                mc.gameMode.startDestroyBlock(targetPos,targetFace);
                                phase="breaking";reason="Breaking "+targetBlockBefore;
                            } else {
                                BlockPos against=targetPos.relative(targetFace);
                                targetBlockBefore=blockAt(mc,against);
                                var result=mc.gameMode.useItemOn(mc.player,InteractionHand.MAIN_HAND,hit);
                                if(result.consumesAction()) mc.player.swing(InteractionHand.MAIN_HAND);
                                actionTicksLeft=2;phase="placing";reason="Placing against "+targetBlockBefore;
                            }
                        } else finish("blocked",Actions.FAIL_PRECONDITION,"Nothing in reach under the crosshair");
                    }
                    case "respawn" -> {
                        if(dead && onDeathScreen && !hardcore) {
                            // Exactly what the death screen's own button does; no synthetic key events.
                            respawning=true;mc.player.respawn();mc.gui.setScreen(null);
                            phase="respawning";reason="Respawn requested; waiting for a live player";
                        } else finish("blocked",Actions.FAIL_PRECONDITION,hardcore?"Hardcore world; respawn is not available":"Not on the death screen");
                    }
                    default -> finish("failed",Actions.FAIL_CONTROLLER,"Unknown action type reached the tick");
                }
            }
            if(!activeType.isEmpty() && activeReflex.equals(Reflexes.NONE) && mc.player!=null) {
                peakY=Math.max(peakY,mc.player.getY());
                if(!mc.player.onGround()) leftGround=true;
                progress.sample(remainingWork(mc,activeType,null));
                // A decision dies when what it assumed stops being true, not when a clock says it is old.
                String broken=Actions.violated(assumes,mc);
                if(!broken.isEmpty()) finish("blocked",Actions.FAIL_ASSUMPTION,"Assumption no longer holds: "+broken);
                else if(now-started>deadlineMs && !activeType.equals("navigate")) finish("blocked",Actions.FAIL_DEADLINE,"Action deadline exceeded");
                else switch(activeType) {
                    case "skill" -> {
                        try {
                            String result=skill.tick(mc);
                            if(result!=null) finish("succeeded",Actions.FAIL_NONE,result);
                        } catch(RuntimeException error) {finish("blocked",Actions.FAIL_PRECONDITION,error.getMessage());}
                    }
                    case "navigate" -> {
                        restrictNavigation();
                        if(Math.hypot(mc.player.getX()-lastX,mc.player.getZ()-lastZ)>0.3) {lastMovement=now;lastX=mc.player.getX();lastZ=mc.player.getZ();reason="Client position changed (predicted)";}
                        if(Math.hypot(mc.player.getX()-(targetX+0.5),mc.player.getZ()-(targetZ+0.5))<=1.5) arrivalTicks++;else arrivalTicks=0;
                        if(arrivalTicks>=10) finish("succeeded",Actions.FAIL_NONE,"Destination observed for 10 ticks; client observation");
                        else if(now-lastMovement>15000) finish("blocked",Actions.FAIL_NO_PROGRESS,"No observed movement for 15 seconds");
                        else if(now-started>deadlineMs) finish("blocked",Actions.FAIL_DEADLINE,"Navigation deadline exceeded");
                    }
                    case "move" -> {
                        keyFor(mc,moveDirection).setDown(true);
                        if(--actionTicksLeft<=0) finish("succeeded",Actions.FAIL_NONE,"Movement window elapsed");
                    }
                    case "jump" -> {
                        mc.options.keyJump.setDown(actionTicksLeft>7);
                        if(--actionTicksLeft<=0) finish(leftGround?"succeeded":"blocked",leftGround?Actions.FAIL_NONE:Actions.FAIL_PRECONDITION,leftGround?"Left the ground":"Never left the ground");
                    }
                    case "look", "select" -> { if(--actionTicksLeft<=0) finish("succeeded",Actions.FAIL_NONE,reason); }
                    case "break" -> {
                        if(mc.level.getBlockState(targetPos).isAir()) {mc.gameMode.stopDestroyBlock();finish("succeeded",Actions.FAIL_NONE,"Block broken");}
                        else if(--actionTicksLeft<=0) {mc.gameMode.stopDestroyBlock();finish("blocked",Actions.FAIL_NO_PROGRESS,"Block did not break within the tick budget");}
                        else mc.gameMode.continueDestroyBlock(targetPos,targetFace);
                    }
                    case "place" -> {
                        if(--actionTicksLeft<=0) {
                            BlockPos against=targetPos.relative(targetFace);
                            boolean empty=mc.level.getBlockState(against).isAir();
                            finish(empty?"blocked":"succeeded",empty?Actions.FAIL_PRECONDITION:Actions.FAIL_NONE,
                                empty?"Nothing was placed; is a block selected?":"Block placed");
                        }
                    }
                    default -> { }
                }
            }
            JsonObject state=new JsonObject();state.addProperty("protocol",3);state.addProperty("observedAt",now);state.addProperty("epoch",epoch.get());state.addProperty("session",session);
            state.addProperty("online",mc.player!=null);state.addProperty("phase",phase);state.addProperty("reason",reason);state.addProperty("actionId",actionId);
            state.addProperty("canAct",mc.player!=null && mc.gui.screen()==null && !mc.isPaused() && mc.player.getHealth()>0);
            if(mc.level!=null) {
                String world=mc.getCurrentServer()!=null?mc.getCurrentServer().ip:mc.getSingleplayerServer()!=null?mc.getSingleplayerServer().getWorldData().getLevelName():"unknown";
                state.addProperty("worldKey",world+":"+mc.level.dimension());
            }
            if(skill!=null && mc.player!=null) state.add("skillProgress",skill.progress(mc));
            state.addProperty("skillsVersion",4);state.addProperty("survivalVersion",1);
            state.addProperty("reflexArmed",reflexArmed);state.addProperty("reflex",activeReflex);state.addProperty("reflexCount",reflexCount);
            JsonObject queued=pending.get();
            state.addProperty("pendingActionId",queued==null?"":queued.get("actionId").getAsString());
            state.addProperty("bridgeBuild","survival-combat-10");
            if(!lastControllerError.isEmpty()) state.addProperty("lastControllerError",lastControllerError);
            if(!survivalError.isEmpty()) state.addProperty("survivalError",survivalError);
            if(!loadout.last().isEmpty()) state.addProperty("loadout",loadout.last());
            state.add("survival",survival.evidence());
            state.add("survivalEvents",gson.toJsonTree(survivalEvents));
            state.addProperty("progress",progress.score());state.addProperty("stagnantTicks",progress.stagnantTicks());
            state.addProperty("failure",failure);
            state.addProperty("singleplayer",singleplayer);state.addProperty("buildScopeAvailable",singleplayer);
            state.addProperty("tick",ticks);state.addProperty("acting",!activeType.isEmpty());state.addProperty("actionType",activeType);
            state.addProperty("stopReleaseTicks",stopReleaseTicks);state.addProperty("stopReleaseMs",stopReleaseMs);
            state.addProperty("maxStopReleaseTicks",maxStopReleaseTicks);state.addProperty("stopReleaseAt",stopReleaseAt);
            state.add("outcome",JsonParser.parseString(outcome));
            state.addProperty("dead",dead);state.addProperty("deathScreen",onDeathScreen);state.addProperty("hardcore",hardcore);
            state.addProperty("deathMessage",deathMessage);state.addProperty("deaths",deaths);
            state.addProperty("lastDeathAt",lastDeathAt);state.addProperty("lastRespawnAt",lastRespawnAt);
            state.addProperty("canRespawn",dead && onDeathScreen && !hardcore);
            state.addProperty("positionSource","client-predicted");
            publishServerPosition(mc,state);state.addProperty("navigationAvailable",net.fabricmc.loader.api.FabricLoader.getInstance().isModLoaded("baritone-fork"));
            if(mc.player!=null) {state.addProperty("x",mc.player.getX());state.addProperty("y",mc.player.getY());state.addProperty("z",mc.player.getZ());state.addProperty("health",mc.player.getHealth());state.addProperty("onFire",mc.player.isOnFire());state.addProperty("inLava",mc.player.isInLava());state.addProperty("food",mc.player.getFoodData().getFoodLevel());state.addProperty("saturation",mc.player.getFoodData().getSaturationLevel());state.addProperty("dimension",mc.level.dimension().toString());}
            if(navigating) {state.addProperty("targetX",targetX);state.addProperty("targetZ",targetZ);}
            snapshot=gson.toJson(state);
            if(ticks%HISTORY_EVERY_TICKS==0) {
                JsonObject digest=Observations.digest(mc,ticks);
                if(survival.evidence().has("threats")) digest.addProperty("credibleThreats",survival.evidence().getAsJsonArray("threats").size());
                history.addLast(digest);
                while(history.size()>HISTORY_SAMPLES) history.removeFirst();
                JsonArray samples=new JsonArray();for(JsonObject sample:history) samples.add(sample);
                historyView=gson.toJson(samples);
            }
            // Sampling costs nothing while nobody is observing, and cannot influence control.
            if(now<observedWantedUntil && now-observationAt>=100) {JsonObject observed=Observations.build(mc);observed.add("survival",survival.evidence());observation=gson.toJson(observed);observationAt=now;}
            if(captureInFlight.get() && now-captureStartedAt>3000) {captureInFlight.set(false);frameError="Capture readback timed out";}
            if(now<frameWantedUntil && now-frameAt>=200 && mc.level!=null) capture(mc,now);
        } catch(LinkageError|RuntimeException e) {
            // The class name alone is not a diagnosis. A controller fault disarms safety and stops
            // the body, so it is rare by construction and worth a full stack trace in the client
            // log; the operator's terminal only ever sees the summary.
            org.slf4j.LoggerFactory.getLogger("windove-bridge").error("Controller error on client tick {}",ticks,e);
            lastControllerError=e.toString();
            disarm("Controller error");halt("Controller error: "+e.getClass().getSimpleName());phase="blocked";
            snapshot=gson.toJson(Map.of("online",false,"phase",phase,"reason",e.toString(),"observedAt",System.currentTimeMillis()));
        }
    }
}

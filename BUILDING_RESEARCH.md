# Generative building — preliminary ideas

Status: exploratory notes, 2026-09-09. This is not an implementation specification or a settled architecture. No generation skill or model is implemented by this document. Reliable gameplay, gathering and survival remain the priority; building comes later.

## Minimal placeholder

The current idea is simply:

```text
generate_structure(bounds, prompt)
```

For example: “Inside these bounds, create a gothic tower.” Bounds describe the region to design within. Their encoding, the output format and how world context reaches the model are deliberately undecided. This is a conceptual stub only, not an API to implement now.

## Experience we would like

Use the existing world as context for an adaptive design. Select a region around a river and ask for a bridge. Then use the proposed result as context and ask for towers and a gate at the entrances. Explore alternatives and revise before building anything in the live world.

Eventually, it could support requests to preserve parts of a design or make smaller changes. Those are ideas to investigate, not required fields or commitments to an editing mechanism. The generated result could become a schematic or another representation the agent can build; that decision remains open.

## Later research direction

The ambition is to develop a new model, potentially building on Dream-Cubed and ideas from leading 3D diffusion systems and Blender-related generation workflows. Dream-Cubed is a promising starting point to evaluate, not a selected architecture. Research should determine what is actually state of the art at that time and which ideas transfer to Minecraft.

Questions for that research:

- Which representation works best: native blocks, continuous 3D representations, or a combination? How much detail and usable structure survives conversion to Minecraft?
- How should generation use existing terrain and previous drafts while following a prompt?
- Which datasets are available and suitable for training, including Minecraft builds and broader 3D assets? Check permissions, quality, scale and coverage of interiors as well as exteriors.
- How should examples be captioned, and would instruction/edit pairs help iterative changes? Could Blender support rendering, synthetic examples or evaluation?
- Should we adapt pretrained models, combine them, or train a new model? What compute and inference costs would each approach require?
- How should we measure visual quality, prompt adherence, terrain fit, edit consistency and whether the result can actually be traversed and built?

Starting reference for later investigation: [Dream-Cubed](https://github.com/SakanaAI/DreamCubed). No new literature review or model comparison has been performed for this note.

## Scope for now

Keep these ideas documented without adding provider abstractions, request schemas, model dependencies or training infrastructure. Revisit the design when gameplay is consistent and the building research begins. Earlier parametric-only and detailed request proposals are alternatives discussed along the way, not requirements for this future work.

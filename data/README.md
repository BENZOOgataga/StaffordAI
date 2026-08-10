# First-name pool

Stafford generates a hire's name from this pool. The name is immutable: you do not choose
the name of someone you hire.

## Rules

Draw without replacement, so no two live hires collide.

Record every name that has ever been used, and never recycle one after a firing. Task
history has to keep one owner per name, and a second Marion six months later makes an old
summary unreadable.

187 names is enough that exhaustion is not a real concern. If it ever empties, that is a
signal to ask Benzoo rather than to start reusing.

## What was changed from the source

Source is the most common first names given in France between 2000 and 2023, top 100 per
sex.

One mixed pool rather than two, because a hire's name carries no other meaning.

Accent variants and near-twins collapsed to one canonical form. Two agents distinguishable
only by a diacritic (Mael and Maël) or by a silent letter (Matéo, Mattéo, Mathéo) is a
support problem, not a feature.

Three names removed because they belong to people in Benzoo's world: his own first name,
his colleague's, and his IT director's. An agent sharing a name with a real colleague makes
every status summary ambiguous.

## If this goes public

The pool is French because Benzoo is French. Make it configurable rather than hardcoded, so
someone else can supply their own list, and keep the drawing and never-recycle logic
independent of which pool is loaded.
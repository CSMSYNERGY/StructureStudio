// jack-agent: the pieces that ship. Add a piece here and agent.ts offers its tools and runs its cards.

import type { Piece } from "./types.ts";
import { memoryPiece } from "./memory.ts";
import { setupPiece } from "./setup.ts";
import { rulesPiece } from "./rules.ts";
import { lookupsPiece } from "./lookups.ts";
import { draftsPiece } from "./drafts.ts";
import { sendsPiece } from "./sends.ts";
import { readsPiece } from "./reads.ts";
import { changeOrdersPiece } from "./changeorders.ts";
import { inventoryPiece } from "./inventory.ts";
import { buildSchedulePiece } from "./buildschedule.ts";
import { deliveryPiece } from "./delivery.ts";
import { commissionsPiece } from "./commissions.ts";
import { insulationPiece } from "./insulation.ts";
import { optionsPiece } from "./options.ts";

// Look-ups before drafts: drafts resolves a look-up list's rows through lookups.ts. Sends after drafts:
// a reply card that sends is made by drafts.ts and run by sends.ts.
// v2 (record changes and reads) after: reads and change orders use lookups.ts too.
export const ALL_PIECES: Piece[] = [
  memoryPiece, setupPiece, rulesPiece, lookupsPiece, draftsPiece, sendsPiece,
  readsPiece, changeOrdersPiece, inventoryPiece, buildSchedulePiece, deliveryPiece, commissionsPiece,
  insulationPiece, optionsPiece,
];

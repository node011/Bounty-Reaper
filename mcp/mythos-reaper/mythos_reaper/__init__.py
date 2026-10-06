"""mythos-reaper — Mythos-style audit harness for bountyreaper.

One engine, two modes:
  WHITE-BOX  — rank source files 1-5 by dangerous-sink density, audit queue,
               Gate A probe promotion.
  BLACK/GRAY-BOX — build a threat model from recon inventory, refine into
               hypotheses, same Gate A promotion discipline.

Adapted from Anthropic Mythos Preview (via mini-mythos → mythos-web).
"""

from . import gate, oast, scoring, state, threat_model

__version__ = "0.1.0"
__all__ = ["gate", "oast", "scoring", "state", "threat_model"]

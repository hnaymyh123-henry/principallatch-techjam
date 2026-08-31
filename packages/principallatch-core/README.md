# @principallatch/core

Competition-scoped primitives for PrincipalLatch signed mandates. The package is
deliberately small: a closed authority schema, deterministic bytes, Ed25519
signing and verification, issuer-key commitments, and lifecycle classification.

It is not a general delegation protocol or a repackaged external SDK. The
resource gateway remains the enforcement point; this package only defines and
verifies the authority artifact consumed at that boundary.

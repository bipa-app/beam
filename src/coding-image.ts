declare const BEAM_RELEASE_CODING_IMAGE: string | undefined;

const IMAGE_DIGEST_SHAPE = /^ghcr\.io\/bipa-app\/beam-coding@sha256:[a-f0-9]{64}$/;

/** Resolve only immutable Beam coding image identities. Release builds inject one. */
export function beamCodingImage(): string | undefined {
  const override = process.env.BEAM_CODING_IMAGE;
  const injected =
    typeof BEAM_RELEASE_CODING_IMAGE === "string" ? BEAM_RELEASE_CODING_IMAGE : undefined;
  const image = override ?? injected;
  if (image === undefined || image === "") return undefined;
  if (!IMAGE_DIGEST_SHAPE.test(image)) {
    throw new Error(
      "BEAM_CODING_IMAGE must be ghcr.io/bipa-app/beam-coding@sha256:<64 lowercase hex>",
    );
  }
  return image;
}

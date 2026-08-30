/**
 * Goal: Managed-provider setup accepts only immutable Beam coding images and
 * maps each provider to its provider-owned resource.
 *
 * Method: Resolve representative environment override values, then inspect
 * the target specs produced for each supported managed provider.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { beamCodingImage } from "../src/coding-image.ts";
import { managedTargetSpec } from "../src/provider/setup.ts";

const IMAGE =
  "ghcr.io/bipa-app/beam-coding@sha256:" + "a".repeat(64);
const ORIGINAL_IMAGE = process.env.BEAM_CODING_IMAGE;

afterEach(() => {
  if (ORIGINAL_IMAGE === undefined) {
    delete process.env.BEAM_CODING_IMAGE;
  } else {
    process.env.BEAM_CODING_IMAGE = ORIGINAL_IMAGE;
  }
});

describe("Beam coding image", () => {
  test("requires an immutable digest", () => {
    process.env.BEAM_CODING_IMAGE = IMAGE;
    expect(beamCodingImage()).toBe(IMAGE);
    process.env.BEAM_CODING_IMAGE = "ghcr.io/bipa-app/beam-coding:latest";
    expect(() => beamCodingImage()).toThrow("BEAM_CODING_IMAGE");
  });

  test("pins image-backed provider resources", () => {
    expect(managedTargetSpec("box")).toEqual({ type: "box", environment: "beam" });
    expect(managedTargetSpec("e2b", IMAGE)).toEqual({
      type: "e2b",
      template: "beam-coding",
    });
    expect(managedTargetSpec("modal", IMAGE)).toEqual({
      type: "modal",
      image: IMAGE,
    });
    expect(managedTargetSpec("daytona", IMAGE)).toEqual({
      type: "daytona",
      snapshot: "beam-coding",
    });
    expect(() => managedTargetSpec("modal")).toThrow("immutable coding image");
  });
});

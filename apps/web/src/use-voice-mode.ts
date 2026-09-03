import { useEffect, useRef, useState } from "react";
import {
  VoiceModeController,
  type VoiceModeControllerDeps,
  type VoiceModeControllerOptions
} from "./voice-mode-controller.js";
import { voiceModeStatusLabel, type VoiceModeState } from "./voice-mode-machine.js";

export type UseVoiceModeBinding = {
  voiceState: VoiceModeState;
  voiceStatusLabel: string;
  voiceController: VoiceModeController;
};

/**
 * Thin React binding for Voice Mode. The controller is created once with
 * proxy deps so re-renders (and fresh closures) never disturb an in-flight
 * utterance; unmount disposes capture/STT/timer resources.
 */
export function useVoiceMode(
  deps: VoiceModeControllerDeps,
  options: VoiceModeControllerOptions = {}
): UseVoiceModeBinding {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const controllerRef = useRef<VoiceModeController | null>(null);
  if (controllerRef.current === null) {
    const proxy: VoiceModeControllerDeps = {
      startCapture: () => depsRef.current.startCapture(),
      stopCapture: (handle) => depsRef.current.stopCapture(handle),
      releaseCapture: (handle) => depsRef.current.releaseCapture(handle),
      transcribe: (audio, transcribeOptions) =>
        depsRef.current.transcribe(audio, transcribeOptions),
      sendRuntimeText: (utteranceId, text) =>
        depsRef.current.sendRuntimeText(utteranceId, text),
      speakSentence: (sentence) => depsRef.current.speakSentence(sentence),
      finishSpeech: (utteranceId) => depsRef.current.finishSpeech(utteranceId),
      cancelSpeech: (utteranceId) => depsRef.current.cancelSpeech(utteranceId),
      interruptRuntimeTurn: () => depsRef.current.interruptRuntimeTurn()
    };
    controllerRef.current = new VoiceModeController(proxy, {
      ...(optionsRef.current.maxRecordingMs === undefined
        ? {}
        : { maxRecordingMs: optionsRef.current.maxRecordingMs }),
      ...(optionsRef.current.createUtteranceId === undefined
        ? {}
        : { createUtteranceId: optionsRef.current.createUtteranceId })
    });
  }

  const controller = controllerRef.current;
  const [voiceState, setVoiceState] = useState<VoiceModeState>(() => controller.getState());

  useEffect(() => controller.subscribe(setVoiceState), [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  return {
    voiceState,
    voiceStatusLabel: voiceModeStatusLabel(voiceState.status),
    voiceController: controller
  };
}

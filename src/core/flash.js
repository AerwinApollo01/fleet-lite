// What a power cut does to an update, depending on storage. A teaching model of the real logic.
export const STAGES = [
  { id: 'download', label: 'While downloading' },
  { id: 'writing', label: 'While writing the firmware' },
  { id: 'switching', label: 'Right after switching over' },
  { id: 'healthy', label: 'After passing the health check' },
];

export function powerCutOutcome({ slots, stage, recoveryPath = false }) {
  if (stage === 'download') {
    return { state: 'safe', title: 'Runs the old firmware', detail: 'Nothing has been written yet. The download resumes when power returns.' };
  }
  if (stage === 'healthy') {
    return { state: 'safe', title: 'Runs the new firmware', detail: 'The update had already proved itself, so it stays.' };
  }
  if (slots === 2) {
    return stage === 'writing'
      ? { state: 'safe', title: 'Runs the old firmware', detail: 'The update was going to the spare slot, so the running copy was never touched.' }
      : { state: 'safe', title: 'Goes back to the old firmware', detail: 'The new firmware never reported healthy, so the bootloader returns to the other slot.' };
  }
  if (stage === 'switching') {
    return { state: 'safe', title: 'Tries the new firmware', detail: 'Writing had finished, so a complete copy exists. If it’s faulty, there’s no old copy to go back to.' };
  }
  return recoveryPath
    ? { state: 'warn', title: 'Waits to be reflashed', detail: 'The only copy is half overwritten, but a protected bootloader survives and can receive the firmware again.' }
    : { state: 'bad', title: 'May not start', detail: 'The only copy is half overwritten, with nothing to fall back on. Someone may need to visit the vehicle.' };
}

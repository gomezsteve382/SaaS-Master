// @vitest-environment jsdom
//
// Task #792 — shared drag-and-drop dump picker primitives. Covers:
//   1. DumpDropZone button: click-to-browse still forwards the file.
//   2. DumpDropZone button: dropping a file fires onFile.
//   3. DumpDropZone button: dragenter with Files toggles the hover hint;
//      dragleave clears it.
//   4. DumpDropZone button: dragenter without Files (text drags) ignored.
//   5. DumpDropArea wrapper: dropping on a non-button child anywhere
//      inside the area still fires onFile (this is the "whole card is a
//      drop target" guarantee the ECM/ADCM tabs rely on).
//   6. DumpDropArea wrapper: shows the overlay hint while hovering and
//      clears it when the drag leaves.

import React from 'react';
import { describe, it, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import DumpDropZone, { DumpDropArea } from '../DumpDropZone.jsx';

afterEach(cleanup);

function makeFile(name='ecm.bin'){
  return new File([new Uint8Array([1,2,3,4])], name, {type:'application/octet-stream'});
}
function fileDT(file){
  return { types:['Files'], files:file?[file]:[], dropEffect:'none' };
}

describe('DumpDropZone (button)', () => {
  it('click-to-browse forwards the selected file', () => {
    const onFile = vi.fn();
    render(<DumpDropZone onFile={onFile} label="Load .bin"/>);
    const input = document.querySelector('input[type=file]');
    const f = makeFile();
    fireEvent.change(input, { target: { files: [f] } });
    expect(onFile).toHaveBeenCalledWith(f);
  });

  it('drop forwards the dropped file', () => {
    const onFile = vi.fn();
    render(<DumpDropZone onFile={onFile} label="Load .bin"/>);
    const label = screen.getByText(/Load \.bin/).closest('label');
    const f = makeFile('adcm.bin');
    fireEvent.drop(label, { dataTransfer: fileDT(f) });
    expect(onFile).toHaveBeenCalledWith(f);
  });

  it('shows drop hint on dragenter with Files and clears on dragleave', () => {
    const onFile = vi.fn();
    render(<DumpDropZone onFile={onFile} label="Load ECM .bin"/>);
    const label = screen.getByText('Load ECM .bin').closest('label');
    fireEvent.dragEnter(label, { dataTransfer: fileDT() });
    expect(screen.getByText(/Drop \.bin to load/)).toBeTruthy();
    fireEvent.dragLeave(label, { dataTransfer: fileDT() });
    expect(screen.getByText('Load ECM .bin')).toBeTruthy();
  });

  it('ignores dragenter without Files (text selection drags)', () => {
    const onFile = vi.fn();
    render(<DumpDropZone onFile={onFile} label="Load ECM .bin"/>);
    const label = screen.getByText('Load ECM .bin').closest('label');
    fireEvent.dragEnter(label, { dataTransfer: { types:['text/plain'], files:[] } });
    expect(screen.getByText('Load ECM .bin')).toBeTruthy();
    expect(screen.queryByText(/Drop \.bin to load/)).toBeNull();
  });
});

describe('DumpDropArea (whole-card wrapper)', () => {
  it('drops on a non-button child still fire onFile', () => {
    const onFile = vi.fn();
    render(
      <DumpDropArea onFile={onFile} accent="#000" hint="DROP HERE">
        <div data-testid="card-body">
          <div data-testid="random-child">some unrelated content</div>
        </div>
      </DumpDropArea>
    );
    const child = screen.getByTestId('random-child');
    const f = makeFile('ecm.bin');
    fireEvent.drop(child, { dataTransfer: fileDT(f) });
    expect(onFile).toHaveBeenCalledWith(f);
  });

  it('shows overlay hint on dragenter and clears on dragleave', () => {
    const onFile = vi.fn();
    render(
      <DumpDropArea onFile={onFile} accent="#000" hint="DROP ECM HERE">
        <div data-testid="card-body">body</div>
      </DumpDropArea>
    );
    const child = screen.getByTestId('card-body');
    expect(screen.queryByText('DROP ECM HERE')).toBeNull();
    fireEvent.dragEnter(child, { dataTransfer: fileDT() });
    expect(screen.getByText('DROP ECM HERE')).toBeTruthy();
    fireEvent.dragLeave(child, { dataTransfer: fileDT() });
    expect(screen.queryByText('DROP ECM HERE')).toBeNull();
  });

  it('drop on inner DumpDropZone nested inside DumpDropArea fires onFile exactly once', () => {
    // Regression for the reviewer's concern: without stopPropagation,
    // a drop on the inner picker label would bubble to the outer area
    // and double-fire onFile (and worse, leave the outer overlay stuck
    // on because the depth counter never resets).
    const onFile = vi.fn();
    render(
      <DumpDropArea onFile={onFile} accent="#000" hint="OUTER">
        <DumpDropZone onFile={onFile} accent="#000" label="INNER BUTTON"/>
      </DumpDropArea>
    );
    const innerLabel = screen.getByText('INNER BUTTON').closest('label');
    const f = makeFile('once.bin');
    fireEvent.drop(innerLabel, { dataTransfer: fileDT(f) });
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(f);
    // Overlay must not be stuck on after the inner-consumed drop.
    expect(screen.queryByText('OUTER')).toBeNull();
  });

  it('ignores non-file drags inside the area', () => {
    const onFile = vi.fn();
    render(
      <DumpDropArea onFile={onFile} accent="#000" hint="DROP HERE">
        <div data-testid="card-body">body</div>
      </DumpDropArea>
    );
    const child = screen.getByTestId('card-body');
    fireEvent.dragEnter(child, { dataTransfer: { types:['text/plain'], files:[] } });
    expect(screen.queryByText('DROP HERE')).toBeNull();
    fireEvent.drop(child, { dataTransfer: { types:['text/plain'], files:[] } });
    expect(onFile).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
//
// Task #792 — Integration coverage: dropping a .bin onto the ECM and
// ADCM inspector CARDS (not the small button) must trigger the same
// inspector-load pipeline as the click-to-browse picker. The first
// pass shipped drop handlers only on the button label, so dropping
// anywhere else on the card silently failed. The fix wraps each
// inspector card in `DumpDropArea`, which is what these tests prove.
//
// Trick: instead of synthesizing a file that parseModule classifies
// as a real GPEC2A / BCM image (which would require valid signature
// bytes), we drop a TOO-SMALL file. The picker's existing too-small
// guard surfaces a distinctive "isn't a full ECM dump" / "isn't a
// full ADCM dump" card. If that card renders after the drop, the
// drop reached onInspectFile → FileReader → moduleTooSmall — i.e.
// the exact same code path the click-to-browse picker uses.

import React from 'react';
import { describe, it, afterEach, expect } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import EcmTab from '../EcmTab.jsx';
import AdcmTab from '../AdcmTab.jsx';
import { MasterVinProvider } from '../../lib/masterVinContext.jsx';

afterEach(cleanup);

function tinyFile(name='tiny.bin'){
  return new File([new Uint8Array(128)], name, { type: 'application/octet-stream' });
}
function fileDT(file){
  return { types:['Files'], files:[file], dropEffect:'none' };
}
function renderWithMasterVin(node){
  return render(<MasterVinProvider setPg={()=>{}}>{node}</MasterVinProvider>);
}

describe('ECM tab — drop on inspector card', () => {
  it('drop on the card title (non-button) reaches the same too-small guard as the picker', async () => {
    renderWithMasterVin(<EcmTab/>);
    const title = await screen.findByText(/ECM DUMP INSPECTOR/);
    await act(async () => {
      fireEvent.drop(title, { dataTransfer: fileDT(tinyFile()) });
    });
    await waitFor(() => {
      expect(screen.getByText(/isn't a full ECM dump/i)).toBeTruthy();
    });
  });
});

describe('ADCM tab — drop on inspector card', () => {
  it('drop on the card title (non-button) reaches the same too-small guard as the picker', async () => {
    renderWithMasterVin(<AdcmTab/>);
    const title = await screen.findByText(/ADCM DUMP INSPECTOR/);
    await act(async () => {
      fireEvent.drop(title, { dataTransfer: fileDT(tinyFile()) });
    });
    await waitFor(() => {
      expect(screen.getByText(/isn't a full ADCM dump/i)).toBeTruthy();
    });
  });
});

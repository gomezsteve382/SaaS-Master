/**
 * WiTech Services Tab
 *
 * Reference panel for the four wiTECH/DealerConnect API contracts extracted
 * from masterModuleDatabase.generated.js. Shows the exact URI, required
 * parameters, and a copyable cURL/fetch template for each service.
 *
 * Services surfaced:
 *   1. getFlashListByVIN  — flash calibration file list for a VIN
 *   2. TCIDProcessedConfig — sales codes / factory option verification
 *   3. getPROXI           — BCM PROXI string from dealer backend
 *   4. getKeyCodes        — stored key codes by VIN + auth PIN
 *
 * These are dealer-server endpoints that require a live wiTECH session or
 * compatible proxy. This tab documents the contracts and lets technicians
 * build the request manually or via a proxy URL.
 */
import React, { useState, useCallback } from 'react';
import { Card, Btn } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { MASTER_MODULES, MASTER_MODULE_METADATA } from '../lib/masterModuleDatabase.generated.js';
import { MasterVinContext } from '../lib/masterVinContext.jsx';

const SERVICES = [
  {
    id: 'flashList',
    icon: '⚡',
    name: 'Flash File Lookup by VIN',
    method: 'getFlashListByVIN',
    uri: '/service/mds2002/Dispatcher',
    description: 'Returns the list of available ECU flash calibration files for a given VIN. Equivalent to wiTECH "Flash ECU" → file list.',
    params: [
      { key: 'SERVICE',  required: true,  hint: 'getFlashListByVIN' },
      { key: 'BROWSER',  required: true,  hint: 'Chrome/120.0.0.0' },
      { key: 'LOCALE',   required: true,  hint: 'en_US' },
      { key: 'VIN',      required: true,  hint: 'Enter VIN below' },
    ],
    vinParam: 'VIN',
    color: C.a1,
  },
  {
    id: 'salesCode',
    icon: '🏷️',
    name: 'Sales Code / Factory Config',
    method: 'TCIDProcessedConfig',
    uri: '/service/repair/scantools/SalesCodeAction.do',
    description: 'Returns factory-installed sales codes and option configuration for a VIN + BCM part number. Use to verify what options were installed at the factory.',
    params: [
      { key: 'SERVICE',      required: true,  hint: 'TCIDProcessedConfig' },
      { key: 'LOCALE',       required: true,  hint: 'en_US' },
      { key: 'partnumber',   required: true,  hint: 'BCM part number e.g. 68396561AB' },
      { key: 'enteredVIN',   required: true,  hint: 'Enter VIN below' },
      { key: 'ecu_variant',  required: true,  hint: 'BCM variant string from DID 2023' },
      { key: 'serialnumber', required: true,  hint: 'BCM serial number from DID 2024' },
      { key: 'ecu_type',     required: true,  hint: 'BCM' },
    ],
    vinParam: 'enteredVIN',
    color: C.a2,
  },
  {
    id: 'proxi',
    icon: '🔧',
    name: 'PROXI Fetch from Dealer Backend',
    method: 'getPROXI',
    uri: '/service/mds2002/Dispatcher',
    description: 'Retrieves the BCM PROXI configuration string from the dealer server. Used when replacing a BCM — the new module needs the original vehicle PROXI to configure correctly.',
    params: [
      { key: 'SERVICE',       required: true,  hint: 'getPROXI' },
      { key: 'BROWSER',       required: true,  hint: 'Chrome/120.0.0.0' },
      { key: 'LOCALE',        required: true,  hint: 'en_US' },
      { key: 'action',        required: true,  hint: 'getPROXI' },
      { key: 'vin',           required: true,  hint: 'Enter VIN below' },
      { key: 'electronicPIN', required: true,  hint: 'Dealer auth PIN (4-digit)' },
      { key: 'bcmBrand',      required: true,  hint: 'CHRYSLER or CONTINENTAL or MARELLI' },
    ],
    vinParam: 'vin',
    color: C.a4,
  },
  {
    id: 'keyCodes',
    icon: '🗝️',
    name: 'Key Code Retrieval',
    method: 'getKeyCodes',
    uri: '/service/mds2002/Dispatcher',
    description: 'Returns stored key codes for a VIN from the dealer server. Requires dealer auth PIN. Used when all keys are lost — retrieves the stored cut codes to have new keys made.',
    params: [
      { key: 'SERVICE',  required: true,  hint: 'getKeyCodes' },
      { key: 'BROWSER',  required: true,  hint: 'Chrome/120.0.0.0' },
      { key: 'LOCALE',   required: true,  hint: 'en_US' },
      { key: 'action',   required: true,  hint: 'getKeyCodes' },
      { key: 'vin',      required: true,  hint: 'Enter VIN below' },
      { key: 'authPIN',  required: true,  hint: 'Dealer auth PIN (4-digit)' },
      { key: 'iac',      required: false, hint: 'IAC code (optional)' },
    ],
    vinParam: 'vin',
    color: C.wn,
  },
];

function copyToClipboard(text) {
  try { navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

function buildCurlTemplate(service, vin, proxyBase) {
  const base = proxyBase || 'https://witech.dealer.com';
  const params = service.params.map(p => {
    const val = p.key === service.vinParam ? (vin || '{VIN}') : `{${p.key}}`;
    return `  --data-urlencode "${p.key}=${val}"`;
  }).join(' \\\n');
  return `curl -X POST "${base}${service.uri}" \\\n${params}`;
}

function ServiceCard({ service, vin }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const curl = buildCurlTemplate(service, vin, '');
  const onCopy = useCallback(() => {
    copyToClipboard(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [curl]);

  return (
    <Card style={{ marginBottom: 14, borderLeft: `4px solid ${service.color}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 20 }}>{service.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Nunito'", fontWeight: 800, fontSize: 13, color: service.color, letterSpacing: 0.5 }}>
            {service.name}
          </div>
          <div style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'", marginTop: 2 }}>
            {service.method} · POST {service.uri}
          </div>
        </div>
        <Btn small outline color={service.color} onClick={() => setExpanded(e => !e)}>
          {expanded ? 'HIDE' : 'DETAILS'}
        </Btn>
      </div>

      <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>{service.description}</div>

      {expanded && (
        <>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.tm, letterSpacing: 0.5, marginBottom: 6 }}>PARAMETERS</div>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 60px', gap: '4px 12px', fontSize: 10, fontFamily: "'JetBrains Mono'" }}>
              <div style={{ fontWeight: 700, color: C.tm }}>KEY</div>
              <div style={{ fontWeight: 700, color: C.tm }}>HINT / VALUE</div>
              <div style={{ fontWeight: 700, color: C.tm }}>REQ</div>
              {service.params.map(p => (
                <React.Fragment key={p.key}>
                  <div style={{ color: p.key === service.vinParam ? service.color : C.tx, fontWeight: p.key === service.vinParam ? 700 : 400 }}>{p.key}</div>
                  <div style={{ color: C.ts }}>{p.key === service.vinParam ? (vin || '← use master VIN') : p.hint}</div>
                  <div style={{ color: p.required ? C.er : C.tm }}>{p.required ? 'YES' : 'opt'}</div>
                </React.Fragment>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.tm, letterSpacing: 0.5, marginBottom: 4 }}>cURL TEMPLATE</div>
            <div style={{
              background: '#1A1A1A', color: '#A0FFA0', fontFamily: "'JetBrains Mono'",
              fontSize: 10, padding: '10px 12px', borderRadius: 7, whiteSpace: 'pre', overflowX: 'auto',
            }}>
              {curl}
            </div>
          </div>

          <Btn small color={service.color} onClick={onCopy}>
            {copied ? '✓ COPIED' : 'COPY cURL'}
          </Btn>
        </>
      )}
    </Card>
  );
}

export default function WiTechServicesTab() {
  const { vin: masterVin, vinValid } = React.useContext(MasterVinContext);
  const vin = vinValid ? masterVin : '';

  return (
    <div style={{ padding: '16px 20px', maxWidth: 860, margin: '0 auto' }}>
      <Card glow style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <span style={{ fontSize: 24 }}>🏥</span>
          <div>
            <div style={{ fontFamily: "'Nunito'", fontWeight: 900, fontSize: 18, color: C.tx, letterSpacing: 1 }}>
              wiTECH DEALER SERVICES
            </div>
            <div style={{ fontSize: 11, color: C.tm, marginTop: 2 }}>
              API contracts extracted from wiTECH/CDA6 · requires live dealer server or compatible proxy
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <div style={{ fontSize: 11, color: C.tm }}>
            Source: <span style={{ color: C.a3, fontWeight: 700 }}>masterModuleDatabase.generated.js</span>
            {' · '}
            v{MASTER_MODULE_METADATA.version}
            {' · '}
            {MASTER_MODULES.length} modules
          </div>
          {vinValid && (
            <div style={{ fontSize: 11, color: C.gn, fontWeight: 700, fontFamily: "'JetBrains Mono'" }}>
              ✓ VIN: {masterVin}
            </div>
          )}
          {!vinValid && (
            <div style={{ fontSize: 11, color: C.wn }}>
              ⚠ Set a Master VIN to auto-fill VIN parameters
            </div>
          )}
        </div>
      </Card>

      <div style={{ fontSize: 11, color: C.tm, marginBottom: 14, padding: '8px 12px', background: '#FFF8E1', borderRadius: 7, border: '1px solid #FFCC02' }}>
        <strong>⚠ These are dealer-server endpoints.</strong> They require a live wiTECH DealerConnect session or a compatible proxy (e.g. wiTECH 2.0 local server, AlfaOBD Pro backend, or a MITM proxy capturing dealer traffic). The cURL templates below show the exact request shape — substitute your proxy base URL and auth credentials.
      </div>

      {SERVICES.map(svc => (
        <ServiceCard key={svc.id} service={svc} vin={vin} />
      ))}

      <Card style={{ marginTop: 8, background: '#F8F6FF', borderColor: C.a4 + '44' }}>
        <div style={{ fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, color: C.a4, letterSpacing: 1, marginBottom: 8 }}>
          📋 VERIFIED MODULE ADDRESSES
        </div>
        <div style={{ fontSize: 10, color: C.tm, marginBottom: 8 }}>
          {MASTER_MODULES.filter(m => m.verified).length} verified from wiTECH/CDA6 · {MASTER_MODULES.filter(m => !m.verified).length} from AlfaOBD + Standard CAN pattern
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
          {MASTER_MODULES.map(m => (
            <div key={m.code} style={{
              padding: '6px 10px', borderRadius: 6,
              background: m.verified ? '#F0FFF4' : '#FAFAF8',
              border: `1px solid ${m.verified ? C.gn + '44' : C.bd}`,
              fontSize: 10, fontFamily: "'JetBrains Mono'",
            }}>
              <div style={{ fontWeight: 700, color: m.verified ? C.gn : C.tm }}>{m.code}</div>
              <div style={{ color: C.ts, fontSize: 9 }}>{m.tx} → {m.rx}</div>
              <div style={{ color: m.verified ? C.gn : C.tm, fontSize: 9 }}>
                {m.verified ? '✓ wiTECH verified' : '~ pattern match'}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

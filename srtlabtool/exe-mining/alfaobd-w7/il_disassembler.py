import dnfile, struct, json
pe = dnfile.dnPE("/tmp/SaaS-Master/attached_assets/_extracted/AlfaOBD_managed.exe")
mt=pe.net.mdtables; M=mt.MethodDef.rows; F=mt.Field.rows; FR=mt.FieldRva.rows; MRr=mt.MemberRef.rows
def mname(tok):
    t,rid=tok>>24,tok&0xFFFFFF
    try:
        if t==0x06:return f"{M[rid-1].Name.value}#row{rid-1}"
        if t==0x0A:return MRr[rid-1].Name.value
    except:pass
    return f"tok{tok:08X}"
def fname(tok):
    t,rid=tok>>24,tok&0xFFFFFF
    try:
        if t==0x04:return F[rid-1].Name.value
        if t==0x0A:return MRr[rid-1].Name.value
    except:pass
    return f"fld{tok:08X}"
OPS={0x00:'nop',0x02:'ldarg.0',0x03:'ldarg.1',0x04:'ldarg.2',0x05:'ldarg.3',0x06:'ldloc.0',0x07:'ldloc.1',0x08:'ldloc.2',0x09:'ldloc.3',0x0a:'stloc.0',0x0b:'stloc.1',0x0c:'stloc.2',0x0d:'stloc.3',0x0e:('ldarg.s',1),0x11:('ldloc.s',1),0x12:('ldloca.s',1),0x13:('stloc.s',1),0x14:'ldnull',0x15:'ldc.i4.m1',0x16:'ldc.i4.0',0x17:'ldc.i4.1',0x18:'ldc.i4.2',0x19:'ldc.i4.3',0x1a:'ldc.i4.4',0x1b:'ldc.i4.5',0x1c:'ldc.i4.6',0x1d:'ldc.i4.7',0x1e:'ldc.i4.8',0x1f:('ldc.i4.s',1),0x20:('ldc.i4',4),0x21:('ldc.i8',8),0x25:'dup',0x26:'pop',0x28:('call',4,'m'),0x2a:'ret',0x2b:('br.s',1,'b'),0x2c:('brfalse.s',1,'b'),0x2d:('brtrue.s',1,'b'),0x2e:('beq.s',1,'b'),0x2f:('bge.s',1,'b'),0x30:('bgt.s',1,'b'),0x31:('ble.s',1,'b'),0x32:('blt.s',1,'b'),0x33:('bne.un.s',1,'b'),0x38:('br',4,'b'),0x39:('brfalse',4,'b'),0x3a:('brtrue',4,'b'),0x58:'add',0x59:'sub',0x5a:'mul',0x5b:'div',0x5c:'div.un',0x5d:'rem',0x5e:'rem.un',0x5f:'and',0x60:'or',0x61:'xor',0x62:'shl',0x63:'shr',0x64:'shr.un',0x65:'neg',0x66:'not',0x67:'conv.i1',0x68:'conv.i2',0x69:'conv.i4',0x6a:'conv.i8',0x6d:'conv.u4',0x6e:'conv.u8',0x8d:('newarr',4),0x8e:'ldlen',0x91:'ldelem.u1',0x93:'ldelem.u2',0x94:'ldelem.i4',0x95:'ldelem.u4',0x9c:'stelem.i1',0x9d:'stelem.i2',0x9e:'stelem.i4',0x6f:('callvirt',4,'m'),0x72:('ldstr',4),0x73:('newobj',4,'m'),0x7b:('ldfld',4,'f'),0x7e:('ldsfld',4,'f'),0x80:('stsfld',4,'f'),0x7d:('stfld',4,'f'),0xd1:'conv.u2',0xd2:'conv.u1'}
FE={0x01:'ceq',0x02:'cgt',0x03:'cgt.un',0x04:'clt',0x05:'clt.un',0x09:('ldarg',2),0x0c:('ldloc',2),0x0e:('stloc',2)}
def il_of(row):
    m=M[row];rva=m.Rva
    if rva==0:return b''
    b0=pe.get_data(rva,1)[0]
    if(b0&3)==2:return pe.get_data(rva+1,b0>>2)
    cs=struct.unpack_from('<I',pe.get_data(rva,12),4)[0]
    hs=(struct.unpack_from('<H',pe.get_data(rva,2),0)[0]>>12)*4
    return pe.get_data(rva+hs,cs)
def disasm(row,label):
    code=il_of(row);i=0;out=[f"=== {label}: method {M[row].Name.value!r} (row {row}, {len(code)} IL bytes) ==="]
    while i<len(code):
        off=i;op=code[i];i+=1
        if op==0xfe:
            op2=code[i];i+=1;ent=FE.get(op2)
            if isinstance(ent,tuple):nm,sz=ent;v=int.from_bytes(code[i:i+sz],'little');i+=sz;out.append(f"  {off:04X}: {nm} {v}")
            else:out.append(f"  {off:04X}: {ent}")
            continue
        ent=OPS.get(op)
        if ent is None:out.append(f"  {off:04X}: .byte {op:02X}");continue
        if isinstance(ent,str):out.append(f"  {off:04X}: {ent}");continue
        nm=ent[0];sz=ent[1];kind=ent[2] if len(ent)>2 else None
        raw=code[i:i+sz];i+=sz
        if kind=='m':out.append(f"  {off:04X}: {nm} {mname(int.from_bytes(raw,'little'))}")
        elif kind=='f':out.append(f"  {off:04X}: {nm} {fname(int.from_bytes(raw,'little'))}")
        elif kind=='b':d=int.from_bytes(raw,'little',signed=True);out.append(f"  {off:04X}: {nm} ->{i+d:04X}")
        elif nm in('ldc.i4','ldc.i8'):out.append(f"  {off:04X}: {nm} 0x{int.from_bytes(raw,'little'):X}")
        else:out.append(f"  {off:04X}: {nm} {int.from_bytes(raw,'little',signed=(sz<4))}")
    return "\n".join(out)
rows=[199,1076,1082,1083,1084,1085,1086,1087,1088,1089,1092,1093,1094,1095,1096,1097,1098,1099,1100,1101,1102,1103,1104,1105,1106,1107,1298,25,200]
dump="\n\n".join(disasm(r,"W7-CHAIN") for r in rows)
open("/tmp/w7_full_il.txt","w").write(dump)
# static constants for fields referenced by w7 core + helpers
consts={}
for fr in FR:
    fidx=fr.Field.row_index-1; nm=F[fidx].Name.value
    consts[nm]=pe.get_data(fr.Rva,64).hex()
json.dump(consts,open("/tmp/w7_static_constants.json","w"),indent=1)
print("wrote", len(dump),"bytes IL,",len(consts),"constants")
print(dump[:1400])

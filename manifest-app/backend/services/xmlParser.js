// services/xmlParser.js — Parser de manifiestos XML de la DGA
//
// Extraído de server.js (paso 3 de la separación backend/frontend).
// Módulo puro: recibe el texto del XML, devuelve { header, bls, containers, containerBLs }.

const xml2js = require('xml2js');

// Devuelve el primer valor de un nodo xml2js (que siempre entrega arrays)
function v(obj, key) {
  if (!obj || !obj[key]) return '';
  const val = obj[key];
  return Array.isArray(val) ? (val[0] || '') : val;
}

function parseXmlManifest(xmlText) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlText, { explicitArray: true, trim: true }, (err, result) => {
      if (err) return reject(err);
      try {
        const root     = result['ExportManifest'] || result;
        const manifest = root['Manifest'] ? root['Manifest'][0] : root;
        const header = {
          voyage_no:        v(manifest, 'VoyageNo'),
          vessel_code:      v(manifest, 'VesselCode'),
          biz_company_code: v(manifest, 'BizCompanyCode'),
          loading_port:     v(manifest, 'LoadingLocationCode'),
          unloading_port:   v(manifest, 'UnloadingLocationCode'),
          departure_date:   v(manifest, 'DepartureDate'),
          arrival_date:     v(manifest, 'ArrivalDate'),
        };
        const bls = (manifest['ManifestBL'] || []).map(bl => ({
          bl_no:                   v(bl, 'BLNo'),
          bl_type:                 v(bl, 'BLType'),
          transit_type:            v(bl, 'TransitType'),
          unloading_port_code:     v(bl, 'UnloadingPortCode'),
          goods_name:              v(bl, 'GoodsName').replace(/[\r\n\t]+/g,' ').trim(),
          package_unit_code:       v(bl, 'PackageUnitCode'),
          package_qty:             parseInt(v(bl,'PackageQty'))||0,
          gross_weight:            parseFloat(v(bl,'GrossWeight'))||0,
          value:                   parseFloat(v(bl,'Value'))||0,
          consignor_type:          v(bl,'ConsignorType'),
          consignor_code:          v(bl,'ConsignorCode'),
          consignor_name:          v(bl,'ConsignorName').replace(/&amp;/g,'&'),
          consignor_document_type: v(bl,'ConsignorDocumentType'),
          consignor_document_no:   v(bl,'ConsignorDocumentNo'),
          consignor_country_code:  v(bl,'ConsignorCountryCode'),
          consignor_tel:           v(bl,'ConsignorTel'),
          consignor_email:         v(bl,'ConsignorEmail'),
          consignor_street:        v(bl,'ConsignorStreet'),
          consignor_city:          v(bl,'ConsignorCity'),
          consignor_zip:           v(bl,'ConsignorZipCode'),
          consignee_type:          v(bl,'ConsigneeType'),
          consignee_code:          v(bl,'ConsigneeCode'),
          consignee_name:          v(bl,'ConsigneeName').replace(/&amp;/g,'&'),
          consignee_document_type: v(bl,'ConsigneeDocumentType'),
          consignee_document_no:   v(bl,'ConsigneeDocumentNo'),
          consignee_country_code:  v(bl,'ConsigneeCountryCode'),
          consignee_tel:           v(bl,'ConsigneeTel'),
          consignee_email:         v(bl,'ConsigneeEmail'),
          consignee_street:        v(bl,'ConsigneeStreet'),
          consignee_city:          v(bl,'ConsigneeCity'),
          consignee_zip:           v(bl,'ConsigneeZipCode'),
          notify_name:             v(bl,'NotifyName'),
          notify_code:             v(bl,'NotifyCode'),
          notify_document_type:    v(bl,'NotifyDocumentType'),
          notify_document_no:      v(bl,'NotifyDocumentNo'),
          notify_country_code:     v(bl,'NotifyCountryCode'),
          notify_tel:              v(bl,'NotifyTel'),
          notify_email:            v(bl,'NotifyEmail'),
          notify_street:           v(bl,'NotifyStreet'),
          notify_city:             v(bl,'NotifyCity'),
          notify_zip:              v(bl,'NotifyZipCode'),
        }));
        const containers = (manifest['ManifestContainer']||[]).map(c=>({
          container_no:   v(c,'ContainerNo'),
          container_type: 'R',
          xml_container_type: v(c,'ContainerType') || '',
          package_code:   v(c,'PackageCode'),
          amount:         parseInt(v(c,'Amount'))||0,
          gross_weight:   parseFloat(v(c,'GrossWeight'))||0,
          net_weight:     parseFloat(v(c,'NetWeight'))||0,
          seal_no1:       v(c,'SealNo1'),
        }));
        const containerBLs = (manifest['ContainerBL']||[]).map(cb=>({
          bl_no:        v(cb,'BLNo'),
          container_no: v(cb,'ContainerNo'),
        }));
        resolve({ header, bls, containers, containerBLs });
      } catch(e) { reject(e); }
    });
  });
}

module.exports = { v, parseXmlManifest };

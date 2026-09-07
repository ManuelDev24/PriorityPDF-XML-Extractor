// SiscommateBridge.cs -- C# 5 compatible (.NET Framework 4.0)
// Compilar: csc /target:exe /out:SiscommateBridge.exe /r:System.Data.dll /r:System.Web.Extensions.dll /r:System.Net.dll SiscommateBridge.cs
// Requiere: .NET Framework 4.0+ y VFPOLEDB instalado

using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

class SiscommateBridge
{
    // Rutas anteriores, comentadas — no eliminadas por si hay que volver a alguna:
    // const string DBF_PATH = @"\\192.168.6.2\c$\Projects\MXRS\sismatedata\SisMate\Data"; // ambiente MXRS (hardcodeado, el que usaba este bridge)
    // const string DBF_PATH = @"\\SDQSERVER\c$\Projects\PYRR\SiscomPriority\Sismate\DATA"; // ambiente PYRR (el configurado en Admin, que este bridge no llegaba a leer)

    // La ruta se comparte con el backend mediante variable de entorno o el
    // archivo siscommate-bridge.config junto al ejecutable. El fallback solo
    // conserva compatibilidad con instalaciones anteriores.
    const string DEFAULT_DBF_PATH = @"C:\Users\ecolon\Desktop\Sisom\DATA";
    const int    PORT     = 5001;

    static string GetDbfPath()
    {
        string fromEnv = Environment.GetEnvironmentVariable("SISCOMMATE_DBF_PATH");
        if (String.IsNullOrEmpty(fromEnv))
            fromEnv = Environment.GetEnvironmentVariable("DBF_PATH");
        if (!String.IsNullOrEmpty(fromEnv)) return fromEnv.Trim();

        string configPath = Environment.GetEnvironmentVariable("SISCOMMATE_BRIDGE_CONFIG");
        if (String.IsNullOrEmpty(configPath))
            configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "siscommate-bridge.config");
        if (File.Exists(configPath))
        {
            foreach (string raw in File.ReadAllLines(configPath))
            {
                string line = (raw ?? "").Trim();
                if (line.StartsWith("dbf_path=", StringComparison.OrdinalIgnoreCase))
                {
                    string value = line.Substring("dbf_path=".Length).Trim();
                    if (!String.IsNullOrEmpty(value)) return value;
                }
            }
        }
        return DEFAULT_DBF_PATH;
    }

    static string GetConnectionString()
    {
        return "Provider=VFPOLEDB.1;Data Source=" + GetDbfPath() + ";Collating Sequence=machine;";
    }

    static void Main(string[] args)
    {
        var listener = new HttpListener();
        listener.Prefixes.Add("http://localhost:" + PORT + "/");
        listener.Start();
        Console.WriteLine("SiscommateBridge corriendo en http://localhost:" + PORT + "/");
        Console.WriteLine("Ctrl+C para detener.\n");

        while (true)
        {
            try
            {
                var ctx  = listener.GetContext();
                var req  = ctx.Request;
                var resp = ctx.Response;

                string path   = req.Url.AbsolutePath.ToLower();
                string method = req.HttpMethod.ToUpper();

                resp.Headers.Add("Access-Control-Allow-Origin", "*");
                resp.ContentType = "application/json; charset=utf-8";

                try
                {
                    if (method == "GET" && path == "/health")
                    {
                        var health = GetHealthStatus();
                        Send(resp, health["ok"].Equals(true) ? 200 : 503,
                            new JavaScriptSerializer().Serialize(health));
                    }
                    else if (method == "GET" && path == "/lote")
                    {
                        int lote = ObtenerUltimoLote();
                        Send(resp, 200, "{\"lote\":" + lote + ",\"siguiente\":" + (lote + 1) + "}");
                    }
                    else if (method == "POST" && path == "/guardar")
                    {
                        string body    = new StreamReader(req.InputStream, Encoding.UTF8).ReadToEnd();
                        var    js      = new JavaScriptSerializer();
                        var    data    = js.Deserialize<Dictionary<string, object>>(body);
                        string result  = GuardarEnDBF(data);
                        Send(resp, 200, "{\"ok\":true,\"msg\":\"" + EscJson(result) + "\"}");
                    }
                    else if (method == "GET" && path == "/consultar")
                    {
                        string voyage = req.QueryString["voyage"] ?? "";
                        var datos = ConsultarManifiesto(voyage);
                        Send(resp, 200, new JavaScriptSerializer().Serialize(datos));
                    }
                    else if (method == "OPTIONS")
                    {
                        resp.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                        resp.Headers.Add("Access-Control-Allow-Headers", "Content-Type");
                        Send(resp, 200, "{}");
                    }
                    else
                    {
                        Send(resp, 404, "{\"error\":\"Ruta no encontrada\"}");
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("[ERROR] " + ex.Message);
                    Send(resp, 500, "{\"error\":\"" + EscJson(ex.Message) + "\"}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[FATAL] " + ex.Message);
            }
        }
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────
    static void Send(HttpListenerResponse resp, int status, string json)
    {
        resp.StatusCode = status;
        byte[] buf = Encoding.UTF8.GetBytes(json);
        resp.ContentLength64 = buf.Length;
        resp.OutputStream.Write(buf, 0, buf.Length);
        resp.OutputStream.Close();
    }

    static string EscJson(string s)
    {
        return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"")
                        .Replace("\r", "").Replace("\n", " ");
    }

    static Dictionary<string, object> GetHealthStatus()
    {
        string dbfPath = GetDbfPath();
        bool providerRegistered = false;
        bool dbfPathAccessible = Directory.Exists(dbfPath);
        bool dbfQuerySuccessful = false;
        string error = "";

        try
        {
            // SOURCES_NAME es "VFPOLEDB" (el nombre que reporta el enumerador
            // OLE DB), no "VFPOLEDB.1" (ese es el ProgID que se usa en la
            // cadena de conexión, "Provider=VFPOLEDB.1;..."). Comparar contra
            // el ProgID acá nunca daba match, aunque el proveedor estuviera
            // bien instalado y registrado.
            var providers = new OleDbEnumerator().GetElements();
            foreach (System.Data.DataRow row in providers.Rows)
            {
                if (String.Equals(row["SOURCES_NAME"].ToString(), "VFPOLEDB",
                    StringComparison.OrdinalIgnoreCase))
                {
                    providerRegistered = true;
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        if (providerRegistered && dbfPathAccessible)
        {
            try
            {
                using (var conn = new OleDbConnection(GetConnectionString()))
                {
                    conn.Open();
                    using (var cmd = new OleDbCommand("SELECT MAX(lotnum) FROM MANIFEST", conn))
                    {
                        cmd.ExecuteScalar();
                        dbfQuerySuccessful = true;
                    }
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }
        }

        var result = new Dictionary<string, object>();
        result["ok"] = providerRegistered && dbfPathAccessible && dbfQuerySuccessful;
        result["process"] = true;
        result["provider_registered"] = providerRegistered;
        result["dbf_path"] = dbfPath;
        result["dbf_path_accessible"] = dbfPathAccessible;
        result["dbf_query_successful"] = dbfQuerySuccessful;
        if (!String.IsNullOrEmpty(error)) result["error"] = error;
        return result;
    }

    // ── Helpers para leer diccionarios ────────────────────────────────────────
    static string GetStr(Dictionary<string, object> d, string k)
    {
        return (d.ContainsKey(k) && d[k] != null) ? d[k].ToString() : "";
    }

    static decimal GetDec(Dictionary<string, object> d, string k)
    {
        decimal v;
        return decimal.TryParse(GetStr(d, k), out v) ? v : 0m;
    }

    // Los campos Date de VFP son DBTYPE_DBDATE (129→133 en el esquema real:
    // MANIFEST.date/sdate/idate/lotdate/topay/arrival, BOL.date/idate).
    // cmd.Parameters.AddWithValue(nombre, DateTime) infiere OleDbType.Date
    // (fecha+hora, DBTYPE_DATE) — un tipo distinto e incompatible con
    // DBTYPE_DBDATE, y VFPOLEDB lo rechaza con "Data type mismatch" en el
    // INSERT completo, no solo en ese parámetro. Forzar DBDate acá es lo que
    // hace que coincida con la columna real.
    static void AddDate(OleDbCommand cmd, string name, DateTime value)
    {
        var p = cmd.Parameters.Add(name, OleDbType.DBDate);
        p.Value = value.Date;
    }

    // Mismo problema que con las fechas: los campos Numeric de VFP son
    // DBTYPE_NUMERIC (131), pero AddWithValue(int) infiere OleDbType.Integer
    // y AddWithValue(decimal) infiere OleDbType.Decimal — ninguno coincide
    // con DBTYPE_NUMERIC y VFPOLEDB rechaza el INSERT completo.
    static void AddNumeric(OleDbCommand cmd, string name, decimal value)
    {
        var p = cmd.Parameters.Add(name, OleDbType.Numeric);
        p.Value = value;
    }

    // ── Consulta de solo lectura ─────────────────────────────────────────────
    // Vista B del análisis de bugs: leer lo que de verdad quedó en la base de
    // SISCOMMATE para un viaje, en vez de confiar solo en el registro local.
    /**
     * Convierte la fila actual de un OleDbDataReader en un diccionario listo
     * para serializar. Los CHAR de VFP vienen rellenos de espacios a la
     * derecha; DBNull se convierte a null (JavaScriptSerializer no sabe
     * serializar DBNull.Value).
     */
    static Dictionary<string, object> ReadRow(OleDbDataReader reader)
    {
        var row = new Dictionary<string, object>();
        for (int i = 0; i < reader.FieldCount; i++)
        {
            object val = reader.GetValue(i);
            if (val == DBNull.Value) val = null;
            else if (val is string) val = ((string)val).TrimEnd();
            else if (val is DateTime) val = ((DateTime)val).ToString("yyyy-MM-dd");
            row[reader.GetName(i)] = val;
        }
        return row;
    }

    static List<Dictionary<string, object>> ConsultarTabla(OleDbConnection conn, string tabla, string voyageNo)
    {
        var filas = new List<Dictionary<string, object>>();
        using (var cmd = new OleDbCommand("SELECT * FROM " + tabla + " WHERE manifest = ?", conn))
        {
            cmd.Parameters.AddWithValue("manifest", voyageNo);
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read()) filas.Add(ReadRow(reader));
            }
        }
        return filas;
    }

    /**
     * Lo que de verdad quedó grabado en SISCOMMATE para un viaje: la fila de
     * MANIFEST y las de BOL/BOLCONT/BOLITEM vinculadas — para comparar contra
     * lo que el editor cree haber enviado.
     */
    static Dictionary<string, object> ConsultarManifiesto(string voyageNo)
    {
        var result = new Dictionary<string, object>();
        using (var conn = new OleDbConnection(GetConnectionString()))
        {
            conn.Open();

            Dictionary<string, object> manifestRow = null;
            using (var cmd = new OleDbCommand("SELECT * FROM MANIFEST WHERE manifest = ?", conn))
            {
                cmd.Parameters.AddWithValue("manifest", voyageNo);
                using (var reader = cmd.ExecuteReader())
                {
                    if (reader.Read()) manifestRow = ReadRow(reader);
                }
            }

            result["encontrado"] = manifestRow != null;
            result["manifest"]   = manifestRow;
            result["bls"]        = ConsultarTabla(conn, "BOL",     voyageNo);
            result["items"]      = ConsultarTabla(conn, "BOLITEM", voyageNo);
            result["containers"] = ConsultarTabla(conn, "BOLCONT", voyageNo);
        }
        return result;
    }

    // ── Lote ──────────────────────────────────────────────────────────────────
    static int ObtenerUltimoLote()
    {
        using (var conn = new OleDbConnection(GetConnectionString()))
        {
            conn.Open();
            using (var cmd = new OleDbCommand("SELECT MAX(lotnum) FROM MANIFEST", conn))
            {
                object res = cmd.ExecuteScalar();
                return (res == null || res == DBNull.Value) ? 0 : Convert.ToInt32(res);
            }
        }
    }

    static int ObtenerUltimoControl(OleDbConnection conn, string tabla)
    {
        using (var cmd = new OleDbCommand("SELECT MAX(control) FROM " + tabla, conn))
        {
            object res = cmd.ExecuteScalar();
            return (res == null || res == DBNull.Value) ? 0 : Convert.ToInt32(res);
        }
    }

    // ── Guardar en DBF ────────────────────────────────────────────────────────
    static string GuardarEnDBF(Dictionary<string, object> data)
    {
        var js = new JavaScriptSerializer();

        var mDict = data.ContainsKey("manifest")
            ? js.Deserialize<Dictionary<string, object>>(js.Serialize(data["manifest"]))
            : new Dictionary<string, object>();

        var blsList = new List<Dictionary<string, object>>();
        if (data.ContainsKey("bls"))
            foreach (var item in (System.Collections.ArrayList)data["bls"])
                blsList.Add(js.Deserialize<Dictionary<string, object>>(js.Serialize(item)));

        var contList = new List<Dictionary<string, object>>();
        if (data.ContainsKey("container_bl"))
            foreach (var item in (System.Collections.ArrayList)data["container_bl"])
                contList.Add(js.Deserialize<Dictionary<string, object>>(js.Serialize(item)));

        using (var conn = new OleDbConnection(GetConnectionString()))
        {
            conn.Open();

            // Verificar duplicado de viaje
            string voyageNo = GetStr(mDict, "voyage_no");
            using (var chk = new OleDbCommand("SELECT COUNT(*) FROM MANIFEST WHERE manifest = ?", conn))
            {
                chk.Parameters.AddWithValue("manifest", voyageNo);
                int exists = Convert.ToInt32(chk.ExecuteScalar());
                if (exists > 0)
                    return "ERROR: El viaje " + voyageNo + " ya existe en SISCOMMATE. Eliminelo primero.";
            }

            int lotenum = ObtenerUltimoLote() + 1;
            Console.WriteLine("[INFO] Insertando lote " + lotenum + " - viaje " + voyageNo);

            // Parsear fechas (C# 5: declarar variable antes del out)
            DateTime arrival, departure;
            DateTime a, d;
            arrival   = DateTime.TryParse(GetStr(mDict, "arrival_date"),   out a) ? a : DateTime.Now;
            departure = DateTime.TryParse(GetStr(mDict, "departure_date"), out d) ? d : DateTime.Now;

            // Carrier desde el manifiesto
            string carrierCode = GetStr(mDict, "carrier_code");
            if (string.IsNullOrEmpty(carrierCode)) carrierCode = "MXS";

            // Puerto descarga desde manifiesto
            string unloadingPort = GetStr(mDict, "unloading_port");
            if (unloadingPort == "SJU" || unloadingPort == "") unloadingPort = "XSJ";
            else if (unloadingPort == "MGE") unloadingPort = "XMG";

            // ── MANIFEST ─────────────────────────────────────────────────────
            // NOTA: "default" es palabra reservada en VFP, se escapa con comillas dobles
            using (var cmd = new OleDbCommand(
                "INSERT INTO MANIFEST " +
                "(manifest,date,mawb,vessel,voyfli,sdate,idate,dtime,forigin," +
                " master1,master2,master3,master4,master5,tind," +
                " origport,discport,destport," +
                " lotnum,lotdate,lottype,\"default\",carrier," +
                " lotamt,topay,plot,agent,arrival,imo,docking)" +
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", conn))
            {
                cmd.Parameters.AddWithValue("manifest", voyageNo);
                AddDate(cmd, "date",     DateTime.Now);
                cmd.Parameters.AddWithValue("mawb",     voyageNo);
                cmd.Parameters.AddWithValue("vessel",   GetStr(mDict, "vessel_name"));
                cmd.Parameters.AddWithValue("voyfli",   voyageNo);
                AddDate(cmd, "sdate",    departure);
                AddDate(cmd, "idate",    departure);
                cmd.Parameters.AddWithValue("dtime",    "18:00");
                cmd.Parameters.AddWithValue("forigin",  "");
                cmd.Parameters.AddWithValue("master1",  "");
                cmd.Parameters.AddWithValue("master2",  "");
                cmd.Parameters.AddWithValue("master3",  "");
                cmd.Parameters.AddWithValue("master4",  "");
                cmd.Parameters.AddWithValue("master5",  "");
                cmd.Parameters.AddWithValue("tind",     "");
                cmd.Parameters.AddWithValue("origport", "DRP");
                cmd.Parameters.AddWithValue("discport", unloadingPort);
                cmd.Parameters.AddWithValue("destport", unloadingPort);
                cmd.Parameters.AddWithValue("lotnum",   lotenum.ToString());
                AddDate(cmd, "lotdate",  DateTime.Now);
                cmd.Parameters.AddWithValue("lottype",  "N");
                cmd.Parameters.AddWithValue("default",  false);
                cmd.Parameters.AddWithValue("carrier",  carrierCode);
                AddNumeric(cmd, "lotamt", 0m);
                AddDate(cmd, "topay",    new DateTime(1899, 12, 30));
                cmd.Parameters.AddWithValue("plot",     "");
                cmd.Parameters.AddWithValue("agent",    false);
                AddDate(cmd, "arrival",  arrival);
                cmd.Parameters.AddWithValue("imo",      GetStr(mDict, "imo"));
                // Antes hardcodeado a "" — se perdía el docking number que el
                // operador sí llena y que el Node ya exige antes de dejar
                // pasar el push (blValidation.js). Confirmado contra un
                // manifiesto real de SISCOMMATE que el campo docking sí se usa.
                cmd.Parameters.AddWithValue("docking",  GetStr(mDict, "docking_number"));
                cmd.ExecuteNonQuery();
            }

            // ── BOL ───────────────────────────────────────────────────────────
            foreach (var bl in blsList)
            {
                string blDiscPort = unloadingPort;

                using (var cmd = new OleDbCommand(
                    "INSERT INTO BOL " +
                    "(manifest,bolno,date,ttype,boltype,consigne,exporter,payee," +
                    " ptype,charges,pind,taxtype,taxamt,taxadi," +
                    " invoice,idate,invamt,sdesc,insamt,dutypaid,rate," +
                    " relno,declno,discport,destport,coriport,cdesport,comvali,comval)" +
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", conn))
                {
                    cmd.Parameters.AddWithValue("manifest", voyageNo);
                    cmd.Parameters.AddWithValue("bolno",    GetStr(bl, "bl_no"));
                    AddDate(cmd, "date",     DateTime.Now);
                    cmd.Parameters.AddWithValue("ttype",    "O");  // O = Ocean
                    cmd.Parameters.AddWithValue("boltype",  "M");
                    cmd.Parameters.AddWithValue("consigne", GetStr(bl, "consignee_name"));
                    cmd.Parameters.AddWithValue("exporter", GetStr(bl, "consignor_name"));
                    cmd.Parameters.AddWithValue("payee",    "");
                    cmd.Parameters.AddWithValue("ptype",    "C");
                    AddNumeric(cmd, "charges", 0m);
                    cmd.Parameters.AddWithValue("pind",     "C");
                    cmd.Parameters.AddWithValue("taxtype",  "E");
                    AddNumeric(cmd, "taxamt",  0m);
                    AddNumeric(cmd, "taxadi",  0m);
                    cmd.Parameters.AddWithValue("invoice",  "");
                    AddDate(cmd, "idate",    new DateTime(1899, 12, 30));
                    AddNumeric(cmd, "invamt", 0m);
                    cmd.Parameters.AddWithValue("sdesc",    "");
                    AddNumeric(cmd, "insamt", 0m);
                    AddNumeric(cmd, "dutypaid", 0m);
                    AddNumeric(cmd, "rate",   0m);
                    cmd.Parameters.AddWithValue("relno",    "");
                    cmd.Parameters.AddWithValue("declno",   "");
                    cmd.Parameters.AddWithValue("discport", blDiscPort);
                    cmd.Parameters.AddWithValue("destport", blDiscPort);
                    cmd.Parameters.AddWithValue("coriport", "");
                    cmd.Parameters.AddWithValue("cdesport", "");
                    cmd.Parameters.AddWithValue("comvali",  "");
                    AddNumeric(cmd, "comval", 0m);
                    cmd.ExecuteNonQuery();
                }
            }

            // ── BOLCONT ───────────────────────────────────────────────────────
            int control = ObtenerUltimoControl(conn, "BOLCONT") + 1;
            foreach (var cbl in contList)
            {
                using (var cmd = new OleDbCommand(
                    "INSERT INTO BOLCONT (manifest,bolno,contain,size,type,control,sec)" +
                    " VALUES (?,?,?,?,?,?,?)", conn))
                {
                    cmd.Parameters.AddWithValue("manifest", voyageNo);
                    cmd.Parameters.AddWithValue("bolno",    GetStr(cbl, "bl_no"));
                    cmd.Parameters.AddWithValue("contain",  GetStr(cbl, "container_no"));
                    cmd.Parameters.AddWithValue("size",     GetStr(cbl, "size"));
                    cmd.Parameters.AddWithValue("type",     "R");
                    cmd.Parameters.AddWithValue("control",  control.ToString());
                    AddNumeric(cmd, "sec",   1m);
                    cmd.ExecuteNonQuery();
                    control++;
                }
            }

            // ── BOLITEM ───────────────────────────────────────────────────────
            control = ObtenerUltimoControl(conn, "BOLITEM") + 1;
            foreach (var bl in blsList)
            {
                string pkgType = GetStr(bl, "package_unit_code");
                if (string.IsNullOrEmpty(pkgType)) pkgType = "BOX";

                using (var cmd = new OleDbCommand(
                    "INSERT INTO BOLITEM " +
                    "(manifest,bolno,qty,ptype,weight,volume,desc,sind,qrec," +
                    " code,value,control,rate,taxamt,taxadi,wind,vind,sec,qty2,value2)" +
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", conn))
                {
                    cmd.Parameters.AddWithValue("manifest", voyageNo);
                    cmd.Parameters.AddWithValue("bolno",    GetStr(bl, "bl_no"));
                    AddNumeric(cmd, "qty",   GetDec(bl, "package_qty"));
                    cmd.Parameters.AddWithValue("ptype",    pkgType);
                    AddNumeric(cmd, "weight", GetDec(bl, "gross_weight"));
                    AddNumeric(cmd, "volume", 0m);
                    cmd.Parameters.AddWithValue("desc",     GetStr(bl, "goods_name"));
                    cmd.Parameters.AddWithValue("sind",     "");
                    AddNumeric(cmd, "qrec",  GetDec(bl, "package_qty"));
                    cmd.Parameters.AddWithValue("code",     GetStr(bl, "hacienda_item_code"));
                    AddNumeric(cmd, "value", GetDec(bl, "value"));
                    cmd.Parameters.AddWithValue("control",  control.ToString());
                    AddNumeric(cmd, "rate",   0m);
                    AddNumeric(cmd, "taxamt", 0m);
                    AddNumeric(cmd, "taxadi", 0m);
                    cmd.Parameters.AddWithValue("wind",     "K");
                    cmd.Parameters.AddWithValue("vind",     "F");
                    AddNumeric(cmd, "sec",   1m);
                    AddNumeric(cmd, "qty2",  0m);
                    AddNumeric(cmd, "value2", 0m);
                    cmd.ExecuteNonQuery();
                    control++;
                }
            }

            return "Lote " + lotenum + " insertado: " + blsList.Count + " BL, " + contList.Count + " contenedores";
        }
    }
}

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
    const string DBF_PATH = @"\\192.168.6.2\c$\Projects\MXRS\sismatedata\SisMate\Data";
    const string CONN_STR = "Provider=VFPOLEDB.1;Data Source=" + DBF_PATH + ";Collating Sequence=machine;";
    const int    PORT     = 5001;

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
                        Send(resp, 200, "{\"ok\":true,\"msg\":\"SiscommateBridge activo\"}");
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

    // ── Lote ──────────────────────────────────────────────────────────────────
    static int ObtenerUltimoLote()
    {
        using (var conn = new OleDbConnection(CONN_STR))
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

        using (var conn = new OleDbConnection(CONN_STR))
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
                cmd.Parameters.AddWithValue("date",     DateTime.Now);
                cmd.Parameters.AddWithValue("mawb",     voyageNo);
                cmd.Parameters.AddWithValue("vessel",   GetStr(mDict, "vessel_name"));
                cmd.Parameters.AddWithValue("voyfli",   voyageNo);
                cmd.Parameters.AddWithValue("sdate",    departure);
                cmd.Parameters.AddWithValue("idate",    departure);
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
                cmd.Parameters.AddWithValue("lotnum",   lotenum);
                cmd.Parameters.AddWithValue("lotdate",  DateTime.Now);
                cmd.Parameters.AddWithValue("lottype",  "N");
                cmd.Parameters.AddWithValue("default",  false);
                cmd.Parameters.AddWithValue("carrier",  carrierCode);
                cmd.Parameters.AddWithValue("lotamt",   0);
                cmd.Parameters.AddWithValue("topay",    new DateTime(1899, 12, 30));
                cmd.Parameters.AddWithValue("plot",     "");
                cmd.Parameters.AddWithValue("agent",    false);
                cmd.Parameters.AddWithValue("arrival",  arrival);
                cmd.Parameters.AddWithValue("imo",      GetStr(mDict, "imo"));
                cmd.Parameters.AddWithValue("docking",  "");
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
                    cmd.Parameters.AddWithValue("date",     DateTime.Now);
                    cmd.Parameters.AddWithValue("ttype",    "O");  // O = Ocean
                    cmd.Parameters.AddWithValue("boltype",  "M");
                    cmd.Parameters.AddWithValue("consigne", GetStr(bl, "consignee_name"));
                    cmd.Parameters.AddWithValue("exporter", GetStr(bl, "consignor_name"));
                    cmd.Parameters.AddWithValue("payee",    "");
                    cmd.Parameters.AddWithValue("ptype",    "C");
                    cmd.Parameters.AddWithValue("charges",  0);
                    cmd.Parameters.AddWithValue("pind",     "C");
                    cmd.Parameters.AddWithValue("taxtype",  "E");
                    cmd.Parameters.AddWithValue("taxamt",   0);
                    cmd.Parameters.AddWithValue("taxadi",   0);
                    cmd.Parameters.AddWithValue("invoice",  "");
                    cmd.Parameters.AddWithValue("idate",    new DateTime(1899, 12, 30));
                    cmd.Parameters.AddWithValue("invamt",   0);
                    cmd.Parameters.AddWithValue("sdesc",    "");
                    cmd.Parameters.AddWithValue("insamt",   0);
                    cmd.Parameters.AddWithValue("dutypaid", 0);
                    cmd.Parameters.AddWithValue("rate",     0);
                    cmd.Parameters.AddWithValue("relno",    "");
                    cmd.Parameters.AddWithValue("declno",   "");
                    cmd.Parameters.AddWithValue("discport", blDiscPort);
                    cmd.Parameters.AddWithValue("destport", blDiscPort);
                    cmd.Parameters.AddWithValue("coriport", "");
                    cmd.Parameters.AddWithValue("cdesport", "");
                    cmd.Parameters.AddWithValue("comvali",  "");
                    cmd.Parameters.AddWithValue("comval",   0);
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
                    cmd.Parameters.AddWithValue("control",  control);
                    cmd.Parameters.AddWithValue("sec",      1);
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
                    cmd.Parameters.AddWithValue("qty",      GetDec(bl, "package_qty"));
                    cmd.Parameters.AddWithValue("ptype",    pkgType);
                    cmd.Parameters.AddWithValue("weight",   GetDec(bl, "gross_weight"));
                    cmd.Parameters.AddWithValue("volume",   0.0);
                    cmd.Parameters.AddWithValue("desc",     GetStr(bl, "goods_name"));
                    cmd.Parameters.AddWithValue("sind",     "");
                    cmd.Parameters.AddWithValue("qrec",     GetDec(bl, "package_qty"));
                    cmd.Parameters.AddWithValue("code",     GetStr(bl, "hacienda_item_code"));
                    cmd.Parameters.AddWithValue("value",    GetDec(bl, "value"));
                    cmd.Parameters.AddWithValue("control",  control);
                    cmd.Parameters.AddWithValue("rate",     0);
                    cmd.Parameters.AddWithValue("taxamt",   0);
                    cmd.Parameters.AddWithValue("taxadi",   0);
                    cmd.Parameters.AddWithValue("wind",     "K");
                    cmd.Parameters.AddWithValue("vind",     "F");
                    cmd.Parameters.AddWithValue("sec",      1);
                    cmd.Parameters.AddWithValue("qty2",     0);
                    cmd.Parameters.AddWithValue("value2",   0);
                    cmd.ExecuteNonQuery();
                    control++;
                }
            }

            return "Lote " + lotenum + " insertado: " + blsList.Count + " BL, " + contList.Count + " contenedores";
        }
    }
}

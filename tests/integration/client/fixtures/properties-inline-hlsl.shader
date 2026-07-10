Shader "Test/PropertiesInlineHlsl" {
  Properties {
    _MainTex ("Base Map", 2D) = "white" {}
    _BaseColor ("Tint", Color) = (1,1,1,1)
  }
  SubShader {
    Pass {
      HLSLPROGRAM
      TEXTURE2D(_MainTex);
      float4 _BaseColor;
      void frag() { /* uses _MainTex, _BaseColor */ }
      ENDHLSL
    }
  }
}

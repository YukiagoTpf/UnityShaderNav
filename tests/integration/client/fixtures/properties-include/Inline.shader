Shader "Test/PropertiesInclude" {
  Properties {
    _MainTex ("Base Map", 2D) = "white" {}
    _BaseColor ("Tint", Color) = (1,1,1,1)
  }
  SubShader {
    Pass {
      HLSLPROGRAM
      #include "Lib.hlsl"
      void frag() {}
      ENDHLSL
    }
  }
}

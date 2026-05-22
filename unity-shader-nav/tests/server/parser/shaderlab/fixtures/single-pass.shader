Shader "Test/Single" {
  SubShader {
    Pass {
      HLSLPROGRAM
      #pragma vertex vert
      float4 vert() : SV_Position { return float4(0,0,0,1); }
      ENDHLSL
    }
  }
}

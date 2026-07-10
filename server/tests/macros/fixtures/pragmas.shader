Shader "T/Pragma" {
  SubShader {
    Pass {
      HLSLPROGRAM
      #pragma vertex vert
      #pragma fragment frag
      void vert() {}
      float4 frag() : SV_Target { return 0; }
      ENDHLSL
    }
  }
}

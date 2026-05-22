Shader "MultiSS" {
  SubShader {
    Tags { "RenderPipeline" = "URP" }
    Pass {
      HLSLPROGRAM
      void v() {}
      ENDHLSL
    }
  }
  SubShader {
    Pass {
      HLSLPROGRAM
      void v2() {}
      ENDHLSL
    }
  }
}

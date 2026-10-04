package com.sentrifugo.pms.controller;

import com.sentrifugo.common.web.ApiResponse;
import com.sentrifugo.pms.model.PmsCycleActivationResponse;
import com.sentrifugo.pms.model.PmsCycleListResponse;
import com.sentrifugo.pms.model.PmsCycleRequest;
import com.sentrifugo.pms.model.PmsCycleResponse;
import com.sentrifugo.pms.service.PmsCycleService;
import com.sentrifugo.pms.utils.PmsCycleCsvExporter;
import com.sentrifugo.pms.utils.PmsPrincipals;
import com.sentrifugo.security.access.RequirePermission;
import com.sentrifugo.security.context.PmsUserPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/** PMS Cycle APIs (screens 1.1-1.6). */
@RestController
@RequestMapping("${pms.api.base.path}/pms-cycle")
@RequiredArgsConstructor
public class PmsCycleController {

    private static final Logger log = LoggerFactory.getLogger(PmsCycleController.class);

    private final PmsCycleService pmsCycleService;
    private final PmsCycleCsvExporter csvExporter;


    @GetMapping("/get/cycles")
    public ResponseEntity<ApiResponse<Object>> getAllCycles(){
        return null;
    }
}

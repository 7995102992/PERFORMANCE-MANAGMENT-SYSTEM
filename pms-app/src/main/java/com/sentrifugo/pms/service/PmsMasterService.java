package com.sentrifugo.pms.service;

import com.sentrifugo.common.exception.DomainException;
import com.sentrifugo.db.dto.PmsCompetencyMasterDTO;
import com.sentrifugo.db.dto.PmsKpiMasterDTO;
import com.sentrifugo.db.dto.PmsKraMasterDTO;
import com.sentrifugo.db.entity.PmsCompetencyMasterEntity;
import com.sentrifugo.db.entity.PmsKpiMasterEntity;
import com.sentrifugo.db.entity.PmsKraMasterEntity;
import com.sentrifugo.db.enums.PmsMasterStatus;
import com.sentrifugo.db.enums.PmsTargetType;
import com.sentrifugo.db.mapper.PmsCompetencyMasterMapper;
import com.sentrifugo.db.mapper.PmsKpiMasterMapper;
import com.sentrifugo.db.mapper.PmsKraMasterMapper;
import com.sentrifugo.db.repository.PmsCompetencyMasterRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateCompetencyRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateKpiRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateKraRepository;
import com.sentrifugo.db.repository.PmsKpiMasterRepository;
import com.sentrifugo.db.repository.PmsKraMasterRepository;
import com.sentrifugo.pms.model.PmsCompetencyRequest;
import com.sentrifugo.pms.model.PmsCompetencyResponse;
import com.sentrifugo.pms.model.PmsKpiRequest;
import com.sentrifugo.pms.model.PmsKpiResponse;
import com.sentrifugo.pms.model.PmsKraRequest;
import com.sentrifugo.pms.model.PmsKraResponse;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * KRA (screens 2.5, 2.6), KPI (2.7, 2.8) and competency (2.9) masters. "Delete" removes a row from every list by
 * clearing {@code is_active} (a soft delete, so history is kept); {@code status} is the separate
 * active / inactive switch. A master that a goal template uses cannot be deleted.
 */
@Service
@RequiredArgsConstructor
public class PmsMasterService {

    private static final Logger log = LoggerFactory.getLogger(PmsMasterService.class);

    /** The units visible in the KPI screens' Unit dropdown (2.7 / 2.8). */
    private static final List<String> KPI_UNITS = List.of("TPD", "kcal/kg", "%", "kWh/t", "Count", "Months", "MPa");

    private final PmsKraMasterRepository kraRepository;
    private final PmsKpiMasterRepository kpiRepository;
    private final PmsCompetencyMasterRepository competencyRepository;
    private final PmsGoalTemplateKraRepository templateKraRepository;
    private final PmsGoalTemplateKpiRepository templateKpiRepository;
    private final PmsGoalTemplateCompetencyRepository templateCompetencyRepository;
    private final PmsKraMasterMapper kraMapper;
    private final PmsKpiMasterMapper kpiMapper;
    private final PmsCompetencyMasterMapper competencyMapper;

    // ── KRA ──────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public List<PmsKraResponse> getKras(String organisationId) {
        return kraRepository.findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(organisationId).stream()
                .map(this::toResponse).toList();
    }

    @Transactional
    public PmsKraResponse createKra(String organisationId, PmsKraRequest request) {
        log.info("Creating KRA for organisation {}", organisationId);
        String name = request.name().trim();
        if (kraRepository.existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrue(organisationId, name)) {
            throw DomainException.conflict("A KRA named '" + name + "' already exists.", "PMS_KRA_DUPLICATE");
        }
        PmsKraMasterEntity kra = kraMapper.toEntity(PmsKraMasterDTO.builder()
                .organisationId(organisationId).name(name).status(parseStatus(request.status())).build());
        return toResponse(kraRepository.save(kra));
    }

    @Transactional
    public PmsKraResponse updateKra(String organisationId, UUID kraId, PmsKraRequest request) {
        log.info("Updating KRA {}", kraId);
        PmsKraMasterEntity kra = findKra(organisationId, kraId);
        String name = request.name().trim();
        if (kraRepository.existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrueAndIdNot(organisationId, name, kraId)) {
            throw DomainException.conflict("A KRA named '" + name + "' already exists.", "PMS_KRA_DUPLICATE");
        }
        kraMapper.updateEntityFromDto(PmsKraMasterDTO.builder().name(name)
                .status(request.status() == null ? null : parseStatus(request.status())).build(), kra);
        return toResponse(kraRepository.save(kra));
    }

    @Transactional
    public void deleteKra(String organisationId, UUID kraId) {
        log.info("Deleting KRA {}", kraId);
        PmsKraMasterEntity kra = findKra(organisationId, kraId);
        if (kpiRepository.existsByKraIdAndIsActiveTrue(kraId)) {
            throw DomainException.conflict("Cannot delete a KRA that still has KPIs under it.", "PMS_KRA_IN_USE");
        }
        if (templateKraRepository.existsByKraId(kraId)) {
            throw DomainException.conflict("Cannot delete a KRA used in a goal template.", "PMS_KRA_IN_USE");
        }
        kra.setIsActive(false);
        kraRepository.save(kra);
    }

    // ── KPI ──────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public List<PmsKpiResponse> getKpis(String organisationId) {
        return kpiRepository.findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(organisationId).stream()
                .map(this::toResponse).toList();
    }

    public List<String> getKpiUnits() {
        return KPI_UNITS;
    }

    @Transactional
    public PmsKpiResponse createKpi(String organisationId, PmsKpiRequest request) {
        log.info("Creating KPI for organisation {}", organisationId);
        PmsKraMasterEntity kra = findKraForKpi(organisationId, request.kraId());
        String name = request.name().trim();
        if (kpiRepository.existsByKraIdAndNameIgnoreCaseAndIsActiveTrue(kra.getId(), name)) {
            throw DomainException.conflict("A KPI named '" + name + "' already exists under this KRA.",
                    "PMS_KPI_DUPLICATE");
        }
        PmsKpiMasterEntity kpi = kpiMapper.toEntity(PmsKpiMasterDTO.builder()
                .organisationId(organisationId)
                .name(name)
                .unit(request.unit().trim())
                .targetType(parseTargetType(request.targetType()))
                .expectedOutcome(request.expectedOutcome())
                .evidenceRequired(request.evidenceRequired())
                .status(parseStatus(request.status()))
                .build());
        kpi.setKra(kra);
        return toResponse(kpiRepository.save(kpi));
    }

    @Transactional
    public PmsKpiResponse updateKpi(String organisationId, UUID kpiId, PmsKpiRequest request) {
        log.info("Updating KPI {}", kpiId);
        PmsKpiMasterEntity kpi = findKpi(organisationId, kpiId);
        PmsKraMasterEntity kra = findKraForKpi(organisationId, request.kraId());
        String name = request.name().trim();
        if (kpiRepository.existsByKraIdAndNameIgnoreCaseAndIsActiveTrueAndIdNot(kra.getId(), name, kpiId)) {
            throw DomainException.conflict("A KPI named '" + name + "' already exists under this KRA.",
                    "PMS_KPI_DUPLICATE");
        }
        kpiMapper.updateEntityFromDto(PmsKpiMasterDTO.builder()
                .name(name)
                .unit(request.unit().trim())
                .targetType(parseTargetType(request.targetType()))
                .status(request.status() == null ? null : parseStatus(request.status()))
                .build(), kpi);
        // Optional text fields are replaced as given (the mapper skips nulls, which would stop them being cleared).
        kpi.setExpectedOutcome(request.expectedOutcome());
        kpi.setEvidenceRequired(request.evidenceRequired());
        kpi.setKra(kra);
        return toResponse(kpiRepository.save(kpi));
    }

    @Transactional
    public void deleteKpi(String organisationId, UUID kpiId) {
        log.info("Deleting KPI {}", kpiId);
        PmsKpiMasterEntity kpi = findKpi(organisationId, kpiId);
        if (templateKpiRepository.existsByKpiId(kpiId)) {
            throw DomainException.conflict("Cannot delete a KPI used in a goal template.", "PMS_KPI_IN_USE");
        }
        kpi.setIsActive(false);
        kpiRepository.save(kpi);
    }

    // ── Competency ───────────────────────────────────────────────────────────

    /** Screen 2.9 "Search by competency": a case-insensitive match on the name. */
    @Transactional(readOnly = true)
    public List<PmsCompetencyResponse> getCompetencies(String organisationId, String search) {
        String needle = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        return competencyRepository.findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(organisationId).stream()
                .filter(c -> needle.isEmpty() || c.getName().toLowerCase(Locale.ROOT).contains(needle))
                .map(this::toResponse).toList();
    }

    @Transactional
    public PmsCompetencyResponse createCompetency(String organisationId, PmsCompetencyRequest request) {
        log.info("Creating competency for organisation {}", organisationId);
        String name = request.name().trim();
        if (competencyRepository.existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrue(organisationId, name)) {
            throw DomainException.conflict("A competency named '" + name + "' already exists.",
                    "PMS_COMPETENCY_DUPLICATE");
        }
        PmsCompetencyMasterEntity competency = competencyMapper.toEntity(PmsCompetencyMasterDTO.builder()
                .organisationId(organisationId).name(name).category(request.category().trim())
                .status(parseStatus(request.status())).build());
        return toResponse(competencyRepository.save(competency));
    }

    @Transactional
    public PmsCompetencyResponse updateCompetency(String organisationId, UUID competencyId,
                                                  PmsCompetencyRequest request) {
        log.info("Updating competency {}", competencyId);
        PmsCompetencyMasterEntity competency = findCompetency(organisationId, competencyId);
        String name = request.name().trim();
        if (competencyRepository.existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrueAndIdNot(
                organisationId, name, competencyId)) {
            throw DomainException.conflict("A competency named '" + name + "' already exists.",
                    "PMS_COMPETENCY_DUPLICATE");
        }
        competencyMapper.updateEntityFromDto(PmsCompetencyMasterDTO.builder().name(name)
                .category(request.category().trim())
                .status(request.status() == null ? null : parseStatus(request.status())).build(), competency);
        return toResponse(competencyRepository.save(competency));
    }

    @Transactional
    public void deleteCompetency(String organisationId, UUID competencyId) {
        log.info("Deleting competency {}", competencyId);
        PmsCompetencyMasterEntity competency = findCompetency(organisationId, competencyId);
        if (templateCompetencyRepository.existsByCompetencyId(competencyId)) {
            throw DomainException.conflict("Cannot delete a competency used in a goal template.",
                    "PMS_COMPETENCY_IN_USE");
        }
        competency.setIsActive(false);
        competencyRepository.save(competency);
    }

    // ── internals ────────────────────────────────────────────────────────────

    private PmsKraMasterEntity findKra(String organisationId, UUID kraId) {
        return kraRepository.findByIdAndOrganisationId(kraId, organisationId)
                .filter(k -> Boolean.TRUE.equals(k.getIsActive()))
                .orElseThrow(() -> DomainException.notFound("KRA not found", "PMS_KRA_NOT_FOUND"));
    }

    /** The parent KRA named in a KPI payload must be an active KRA of the caller's organisation. */
    private PmsKraMasterEntity findKraForKpi(String organisationId, UUID kraId) {
        return kraRepository.findByIdAndOrganisationId(kraId, organisationId)
                .filter(k -> Boolean.TRUE.equals(k.getIsActive()))
                .orElseThrow(() -> DomainException.unprocessable("kra_id does not refer to an existing KRA",
                        "PMS_KRA_NOT_FOUND"));
    }

    private PmsKpiMasterEntity findKpi(String organisationId, UUID kpiId) {
        return kpiRepository.findByIdAndOrganisationId(kpiId, organisationId)
                .filter(k -> Boolean.TRUE.equals(k.getIsActive()))
                .orElseThrow(() -> DomainException.notFound("KPI not found", "PMS_KPI_NOT_FOUND"));
    }

    private PmsCompetencyMasterEntity findCompetency(String organisationId, UUID competencyId) {
        return competencyRepository.findByIdAndOrganisationId(competencyId, organisationId)
                .filter(c -> Boolean.TRUE.equals(c.getIsActive()))
                .orElseThrow(() -> DomainException.notFound("Competency not found", "PMS_COMPETENCY_NOT_FOUND"));
    }

    private static PmsMasterStatus parseStatus(String value) {
        if (value == null || value.isBlank()) {
            return PmsMasterStatus.ACTIVE;
        }
        try {
            return PmsMasterStatus.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("status must be one of: active, inactive", "VALIDATION_ERROR");
        }
    }

    private static PmsTargetType parseTargetType(String value) {
        try {
            return PmsTargetType.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("target_type must be one of: individual, common",
                    "VALIDATION_ERROR");
        }
    }

    private PmsKraResponse toResponse(PmsKraMasterEntity kra) {
        return new PmsKraResponse(kra.getId(), kra.getName(), wire(kra.getStatus()));
    }

    private PmsKpiResponse toResponse(PmsKpiMasterEntity kpi) {
        return new PmsKpiResponse(kpi.getId(), kpi.getKra().getId(), kpi.getKra().getName(), kpi.getName(),
                kpi.getUnit(), wire(kpi.getTargetType()), kpi.getExpectedOutcome(), kpi.getEvidenceRequired(),
                wire(kpi.getStatus()));
    }

    private PmsCompetencyResponse toResponse(PmsCompetencyMasterEntity c) {
        return new PmsCompetencyResponse(c.getId(), c.getName(), c.getCategory(), wire(c.getStatus()));
    }

    private static String wire(Enum<?> value) {
        return value == null ? null : value.name().toLowerCase(Locale.ROOT);
    }
}
